"""Print-failure ("spaghetti") monitoring for 3D-printer cameras.

Runs Obico's 2nd-gen failure-detection model (see
tools/model-prep/fetch_obico_model.py for provenance; post-processing
ported from obico-server ml_api/lib/onnx.py, AGPL-3.0, personal
self-hosted use) against the pipeline's 1 fps preview JPEGs for every
camera that opts in via enabled_detectors @> ['print_defect'].

Detection semantics mirror Obico's server: the per-frame detector is
deliberately noisy (per-box threshold 0.08), and the signal is an
exponentially-weighted mean of the summed box confidences. Raw
sightings publish as kind="print_defect" class="spaghetti" detections
(timeline/overlay); when the EWM crosses printing.defect.alert_threshold
a single class="print_failure" detection publishes — that's what the
alert rule matches. Hysteresis: re-arms when the EWM falls below half
the threshold. NOTIFY ONLY — this module never touches the printer.

Inference runs on the GPU via the fleet's Triton service
(obico_failure model, prepped by triton-entrypoint.sh) with a lazy
CPU-ORT fallback on the bundled ONNX so monitoring survives the
detector backend being switched away from Triton.
"""
from __future__ import annotations

import asyncio
import glob
import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import cv2
import numpy as np
import psycopg

log = logging.getLogger(__name__)

_DATABASE_URL = os.environ.get(
    "FNVR_DATABASE_URL",
    "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable",
)
_NATS_URL = os.environ.get("FNVR_NATS_URL", "nats://nats:4222")
_TRITON_URL = os.environ.get("FNVR_TRITON_URL", "triton:8000")
_TRITON_MODEL = "obico_failure"
_LIVE_DIR = os.environ.get("FNVR_LIVE_DIR", "/var/lib/fnvr/live")
_ONNX_PATH = os.environ.get(
    "FNVR_PRINTMON_ONNX", "/opt/fnvr/models/obico_failure.onnx"
)

_INPUT = 416
# Obico's serving threshold: boxes above this are "positive" and feed
# the smoothed score (server.py THRESH = 0.08).
_BOX_THRESH = 0.08
_NMS_THRESH = 0.4
# Raw spaghetti sightings only publish above this (keeps the timeline
# from collecting one-frame flickers; the EWM still sees everything).
_PUBLISH_THRESH = 0.2
_EWM_ALPHA = 0.22  # ~ last 8 samples carry the weight

# Defaults for the settings-backed knobs.
_DEF_INTERVAL_SEC = 10
_DEF_ALERT_THRESHOLD = 0.40


@dataclass
class Box:
    conf: float
    x1: float  # normalised [0,1] of the source image
    y1: float
    x2: float
    y2: float


class _CamState:
    __slots__ = ("ewm", "alerted")

    def __init__(self) -> None:
        self.ewm = 0.0
        self.alerted = False


_lock = threading.Lock()
_ort_session = None
_triton_dead_logged = False
_states: dict[str, _CamState] = {}


def _nms(boxes: np.ndarray, confs: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = confs.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        over = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[np.where(over <= thresh)[0] + 1]
    return keep


def _preprocess(img_bgr: np.ndarray) -> np.ndarray:
    """Obico's exact input contract: stretch-resize to 416x416,
    BGR→RGB, /255, NCHW float32."""
    resized = cv2.resize(img_bgr, (_INPUT, _INPUT), interpolation=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    return (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]


def _postprocess(boxes_out: np.ndarray, confs_out: np.ndarray) -> list[Box]:
    """The ONNX embeds the YOLO decode: boxes [1,845,1,4] normalised
    x1y1x2y2, confs [1,845,1]. Threshold + NMS (single class)."""
    boxes = boxes_out[0, :, 0, :]
    confs = confs_out[0, :, 0]
    mask = confs > _BOX_THRESH
    boxes, confs = boxes[mask], confs[mask]
    if len(boxes) == 0:
        return []
    keep = _nms(boxes, confs, _NMS_THRESH)
    out = []
    for i in keep:
        x1, y1, x2, y2 = (float(v) for v in boxes[i])
        out.append(
            Box(
                conf=float(confs[i]),
                x1=max(0.0, min(1.0, x1)),
                y1=max(0.0, min(1.0, y1)),
                x2=max(0.0, min(1.0, x2)),
                y2=max(0.0, min(1.0, y2)),
            )
        )
    out.sort(key=lambda b: b.conf, reverse=True)
    return out


def _infer_triton(blob: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    global _triton_dead_logged
    try:
        import tritonclient.http as tc

        client = tc.InferenceServerClient(url=_TRITON_URL, network_timeout=5.0)
        inp = tc.InferInput("input", list(blob.shape), "FP32")
        inp.set_data_from_numpy(blob)
        res = client.infer(
            _TRITON_MODEL,
            [inp],
            outputs=[tc.InferRequestedOutput("boxes"), tc.InferRequestedOutput("confs")],
        )
        _triton_dead_logged = False
        return res.as_numpy("boxes"), res.as_numpy("confs")
    except Exception as e:
        if not _triton_dead_logged:
            log.warning("printmon: triton unavailable (%s) — CPU ORT fallback", e)
            _triton_dead_logged = True
        return None


def _infer_ort(blob: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    global _ort_session
    with _lock:
        if _ort_session is None:
            import onnxruntime as ort

            log.info("printmon: loading CPU fallback model %s", _ONNX_PATH)
            _ort_session = ort.InferenceSession(
                _ONNX_PATH, providers=["CPUExecutionProvider"]
            )
    outs = _ort_session.run(None, {_ort_session.get_inputs()[0].name: blob})
    return outs[0], outs[1]


def detect(img_bgr: np.ndarray) -> list[Box]:
    blob = _preprocess(img_bgr)
    out = _infer_triton(blob)
    if out is None:
        out = _infer_ort(blob)
    return _postprocess(out[0], out[1])


def newest_settled_preview(camera_id: str, max_age_sec: float = 10.0) -> np.ndarray | None:
    """Newest-but-one preview ring frame (mirrors api-server
    snapshot.go: the newest may still be mid-write on some
    filesystems; ours are atomic but the convention is harmless)."""
    files = sorted(
        glob.glob(os.path.join(_LIVE_DIR, f"{camera_id}.*.jpg")),
        key=os.path.getmtime,
    )
    if not files:
        return None
    pick = files[-2] if len(files) > 1 else files[-1]
    if time.time() - os.path.getmtime(pick) > max_age_sec:
        return None
    return cv2.imread(pick)


def _read_settings() -> tuple[int, float]:
    interval, thresh = _DEF_INTERVAL_SEC, _DEF_ALERT_THRESHOLD
    try:
        with psycopg.connect(_DATABASE_URL, autocommit=True) as conn:
            rows = conn.execute(
                """SELECT key, value FROM settings
                   WHERE key IN ('printing.defect.interval_sec',
                                 'printing.defect.alert_threshold')"""
            ).fetchall()
        for k, v in rows:
            f = float(v if isinstance(v, (int, float)) else json.loads(str(v)))
            if k.endswith("interval_sec") and 5 <= f <= 120:
                interval = int(f)
            elif k.endswith("alert_threshold") and 0.1 <= f <= 0.99:
                thresh = f
    except Exception:
        log.debug("printmon: settings read failed — defaults", exc_info=True)
    return interval, thresh


def _monitored_cameras() -> list[str]:
    try:
        with psycopg.connect(_DATABASE_URL, autocommit=True) as conn:
            rows = conn.execute(
                """SELECT id FROM cameras
                   WHERE enabled AND 'print_defect' = ANY(enabled_detectors)"""
            ).fetchall()
        return [r[0] for r in rows]
    except Exception:
        log.warning("printmon: camera query failed", exc_info=True)
        return []


def _detection_json(camera_id: str, class_name: str, conf: float,
                    box: Box | None, ewm: float) -> bytes:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    bbox = (
        {"x": box.x1, "y": box.y1, "w": box.x2 - box.x1, "h": box.y2 - box.y1}
        if box
        else {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    )
    det = {
        "id": uuid.uuid4().hex[:12],
        "camera_id": camera_id,
        "ts": now,
        "class_name": class_name,
        "kind": "print_defect",
        "confidence": round(conf, 4),
        "bbox": bbox,
        "attributes": {"ewm": f"{ewm:.3f}"},
    }
    return json.dumps(det).encode()


def sample(camera_id: str, img_bgr: np.ndarray, alert_threshold: float) -> list[bytes]:
    """One monitoring step for one camera: detect, update EWM, return
    the NATS payloads to publish (0..2). Pure w.r.t. I/O so it unit-
    tests without a bus."""
    boxes = detect(img_bgr)
    score = sum(b.conf for b in boxes)
    st = _states.setdefault(camera_id, _CamState())
    st.ewm = (1 - _EWM_ALPHA) * st.ewm + _EWM_ALPHA * score

    out: list[bytes] = []
    strong = [b for b in boxes if b.conf >= _PUBLISH_THRESH]
    if strong:
        out.append(_detection_json(camera_id, "spaghetti", strong[0].conf,
                                   strong[0], st.ewm))
    if st.ewm >= alert_threshold and not st.alerted:
        st.alerted = True
        out.append(_detection_json(camera_id, "print_failure",
                                   min(0.99, st.ewm),
                                   strong[0] if strong else None, st.ewm))
        log.warning("printmon: %s PRINT FAILURE alert (ewm %.3f)", camera_id, st.ewm)
    elif st.alerted and st.ewm < alert_threshold / 2:
        st.alerted = False
        log.info("printmon: %s re-armed (ewm %.3f)", camera_id, st.ewm)
    return out


async def run() -> None:
    """Monitoring loop. Started from app.py lifespan."""
    import nats

    nc = None
    while True:
        try:
            interval, alert_threshold = _read_settings()
            cams = _monitored_cameras()
            if cams:
                if nc is None or nc.is_closed:
                    nc = await nats.connect(_NATS_URL, name="fnvr-ml-printmon")
                for cam in cams:
                    img = newest_settled_preview(cam)
                    if img is None:
                        continue
                    payloads = await asyncio.to_thread(
                        sample, cam, img, alert_threshold
                    )
                    for p in payloads:
                        await nc.publish(f"fnvr.events.detection.{cam}", p)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            if nc is not None:
                try:
                    await nc.close()
                except Exception:
                    pass
            raise
        except Exception:
            log.exception("printmon: cycle failed — retrying in 30s")
            await asyncio.sleep(30)
