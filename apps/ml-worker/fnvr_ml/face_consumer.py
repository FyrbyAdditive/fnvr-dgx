"""Async face-embedding consumer — the live half of the aligned stack.

The pipeline no longer embeds in-graph. For every captured face it
publishes to fnvr.faces.pending.<camera_id> (JetStream stream
FACES_PENDING, workqueue):

    {"reply_subject": "fnvr.events.detection.<cam>",   # or retro_
     "detection": { id, camera_id, ts, class_name, kind, confidence,
                    bbox, track_id },                  # no attributes
     "crop_jpeg_b64": "<256x256 face crop>"}

This consumer detects landmarks on the crop (SCRFD), aligns
(align.norm_crop) and embeds (TopoFR via inference.embed_face), then
republishes the detection — attributes filled in, crop dropped — to
reply_subject, where event-processor handles it exactly like any
pipeline detection (it accepts the bare-detection shape). The
JetStream buffer means an ml-worker restart delays faces instead of
losing them; max_age bounds the backlog.

Attribute values are STRINGS (event-processor's Detection.Attributes
is map[string]string).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os

import cv2
import numpy as np

from . import inference, scrfd

log = logging.getLogger(__name__)

_NATS_URL = os.environ.get("FNVR_NATS_URL", "nats://nats:4222")
_STREAM = "FACES_PENDING"
_SUBJECTS = "fnvr.faces.pending.>"
_DURABLE = "face-embedder"
_MAX_AGE_S = 3600


def _enrich(detection: dict, crop_jpeg: bytes) -> dict:
    """Embed the face in the crop and fill detection['attributes'].
    On any content problem the detection is returned with an
    embed_status marker instead — the sighting row is kept, the
    matcher/clusterer skip it."""
    arr = np.frombuffer(crop_jpeg, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        detection["attributes"] = {"embed_status": "bad_crop"}
        return detection
    h, w = img.shape[:2]
    faces = scrfd.detect(img)
    face = scrfd.pick_center_face(faces, w, h)
    if face is None:
        detection["attributes"] = {"embed_status": "no_face"}
        return detection
    vec, norm, roll, yaw = inference.embed_face(img, face)
    detection["attributes"] = {
        "embedding": base64.b64encode(vec.astype("<f4").tobytes()).decode(),
        "embedding_model": inference.EMBEDDING_MODEL,
        "norm": f"{norm:.3f}",
        "det_score": f"{face.score:.3f}",
        "roll": f"{roll:.1f}",
        "yaw": f"{yaw:.3f}",
    }
    return detection


async def _process(nc, msg) -> None:
    try:
        payload = json.loads(msg.data)
        reply = payload["reply_subject"]
        detection = payload["detection"]
        crop = base64.b64decode(payload.get("crop_jpeg_b64", ""))
    except Exception:
        log.exception("malformed pending face message — dropping")
        await msg.ack()
        return

    try:
        # ~100-300 ms of ORT CPU per face — keep it off the event loop
        # so /healthz and /detect-and-embed stay responsive.
        detection = await asyncio.to_thread(_enrich, detection, crop)
    except FileNotFoundError as e:
        # Models not seeded yet (pipeline image hasn't started).
        # Redeliver later rather than losing the face.
        log.warning("models not ready (%s) — nak 30s", e)
        await msg.nak(delay=30)
        return
    except Exception:
        log.exception("embed failed — keeping sighting without embedding")
        detection["attributes"] = {"embed_status": "error"}

    await nc.publish(reply, json.dumps(detection).encode())
    await msg.ack()


async def run() -> None:
    """Reconnect-forever consumer loop. Started from app.py lifespan."""
    import nats
    from nats.js.api import RetentionPolicy, StorageType, StreamConfig

    while True:
        nc = None
        try:
            nc = await nats.connect(_NATS_URL, name="fnvr-ml-face-consumer")
            js = nc.jetstream()
            try:
                await js.add_stream(
                    StreamConfig(
                        name=_STREAM,
                        subjects=[_SUBJECTS],
                        retention=RetentionPolicy.WORK_QUEUE,
                        storage=StorageType.FILE,
                        max_age=_MAX_AGE_S,
                    )
                )
            except Exception:
                # Already exists (possibly with equivalent config).
                await js.stream_info(_STREAM)
            sub = await js.pull_subscribe(_SUBJECTS, durable=_DURABLE, stream=_STREAM)
            log.info("face consumer up (stream=%s durable=%s)", _STREAM, _DURABLE)
            while True:
                try:
                    msgs = await sub.fetch(8, timeout=5)
                except (asyncio.TimeoutError, nats.errors.TimeoutError):
                    continue
                for m in msgs:
                    await _process(nc, m)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("face consumer connection lost — retrying in 5s")
            await asyncio.sleep(5)
        finally:
            if nc is not None:
                try:
                    await nc.close()
                except Exception:
                    pass
