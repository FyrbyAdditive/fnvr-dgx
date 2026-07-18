"""SCRFD-10G face detection (CPU ONNX) with 5-point landmarks.

Mirrors the C++ nvinfer parser
(apps/pipeline-supervisor/nvdsinfer_scrfd/nvdsparse_scrfd.cpp) —
same model file, same decode math — but additionally returns the
keypoints, which alignment needs. The pipeline's in-graph SCRFD only
does bbox gating; landmarks are recovered here, on the published
256x256 crop, because stock DeepStream cannot carry per-object
landmarks out of a parser (docs/architecture/face-id.md).

Model: /var/lib/fnvr/models/faceid/scrfd_10g_bnkps.onnx — outputs
renamed to {score,bbox,kps}_{8,16,32} by tools/model-prep/prep_scrfd.py.
Decode: anchor-free distance regression; per stride s, the feature map
is (H/s)x(W/s) with 2 anchors per cell; bbox values are distances
(l,t,r,b) from the cell centre in stride units; kps likewise offsets.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger(__name__)

_MODELS_DIR = os.environ.get("FNVR_MODELS_DIR", "/var/lib/fnvr/models/faceid")
_PATH = os.path.join(_MODELS_DIR, "scrfd_10g_bnkps.onnx")

_STRIDES = (8, 16, 32)
_NUM_ANCHORS = 2
_INPUT_SIZE = 640

_lock = threading.Lock()
_session: ort.InferenceSession | None = None


@dataclass
class Face:
    x1: float  # pixel coords in the source image
    y1: float
    x2: float
    y2: float
    score: float
    kps: np.ndarray  # (5, 2) pixel coords in the source image


def _load() -> ort.InferenceSession:
    global _session
    with _lock:
        if _session is None:
            if not os.path.exists(_PATH):
                raise FileNotFoundError(
                    f"scrfd ONNX not found at {_PATH}; start the pipeline "
                    f"container once to seed the models volume"
                )
            log.info("loading scrfd: %s", _PATH)
            _session = ort.InferenceSession(_PATH, providers=["CPUExecutionProvider"])
    return _session


def _nms(dets: np.ndarray, iou: float) -> list[int]:
    if len(dets) == 0:
        return []
    x1, y1, x2, y2, sc = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1) * (y2 - y1)
    order = sc.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[np.where(ovr <= iou)[0] + 1]
    return keep


def detect(img_bgr: np.ndarray, conf_thresh: float = 0.4, iou_thresh: float = 0.4) -> list[Face]:
    """Detect faces + landmarks. Letterboxes to 640x640 (top-left,
    matching the fixed-shape output tensors), maps results back to
    source pixels, highest score first."""
    sess = _load()
    src_h, src_w = img_bgr.shape[:2]
    scale = _INPUT_SIZE / max(src_w, src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    canvas = np.zeros((_INPUT_SIZE, _INPUT_SIZE, 3), dtype=np.uint8)
    canvas[:new_h, :new_w] = cv2.resize(img_bgr, (new_w, new_h))

    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32)
    blob = ((rgb - 127.5) / 128.0).transpose(2, 0, 1)[None, ...]
    outs = sess.run(None, {sess.get_inputs()[0].name: blob})
    by_name = {sess.get_outputs()[i].name: outs[i] for i in range(len(outs))}

    rows = []
    for s in _STRIDES:
        score = by_name[f"score_{s}"].reshape(-1)
        bbox = by_name[f"bbox_{s}"].reshape(-1, 4) * s
        kps = by_name[f"kps_{s}"].reshape(-1, 5, 2) * s
        w = _INPUT_SIZE // s
        idx = np.where(score >= conf_thresh)[0]
        for i in idx:
            cell = i // _NUM_ANCHORS
            cx, cy = (cell % w) * s, (cell // w) * s
            x1, y1 = cx - bbox[i, 0], cy - bbox[i, 1]
            x2, y2 = cx + bbox[i, 2], cy + bbox[i, 3]
            pts = np.stack([cx + kps[i, :, 0], cy + kps[i, :, 1]], axis=1)
            rows.append((x1, y1, x2, y2, float(score[i]), pts))

    if not rows:
        return []
    dets = np.array([[r[0], r[1], r[2], r[3], r[4]] for r in rows], dtype=np.float32)
    keep = _nms(dets, iou_thresh)

    out: list[Face] = []
    for i in keep:
        x1, y1, x2, y2, sc, pts = rows[i]
        out.append(
            Face(
                x1=max(0.0, x1 / scale), y1=max(0.0, y1 / scale),
                x2=min(float(src_w), x2 / scale), y2=min(float(src_h), y2 / scale),
                score=sc, kps=pts / scale,
            )
        )
    out.sort(key=lambda f: f.score, reverse=True)
    return out


def pick_center_face(faces: list[Face], w: int, h: int) -> Face | None:
    """The pipeline's 256x256 crop is centred on the target face by
    construction (1.4x expansion around the detector bbox) — when the
    crop caught bystanders too, the intended face is the one nearest
    the centre, weighted by score."""
    if not faces:
        return None
    cx, cy = w / 2.0, h / 2.0

    def keyf(f: Face) -> float:
        fx, fy = (f.x1 + f.x2) / 2.0, (f.y1 + f.y2) / 2.0
        dist = ((fx - cx) ** 2 + (fy - cy) ** 2) ** 0.5
        return dist / max(w, h) - 0.25 * f.score

    return min(faces, key=keyf)
