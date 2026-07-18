"""ONNX-runtime inference for the ml-worker sidecar.

This module is THE face embedding implementation for the entire
system: the live pipeline publishes face crops to NATS and the
face_consumer embeds them here; photo-upload enrolment calls
detect_and_embed() directly. Both paths share detect (SCRFD, with
landmarks) → align (align.norm_crop, ArcFace template) → embed
(TopoFR R100) — so live and uploaded embeddings are consistent by
construction.

Models load lazily from the shared volume (seeded by the pipeline
image): scrfd_10g_bnkps.onnx (see scrfd.py) and topofr_r100.onnx
(tools/model-prep/export_topofr.py).

TopoFR contract: 112x112 ArcFace-aligned RGB, (x/255 - 0.5)/0.5,
512-d raw output. The raw L2 norm correlates with input quality
(margin-softmax property) and is kept as a quality signal before
normalising.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

from . import align, scrfd

log = logging.getLogger(__name__)

EMBEDDING_MODEL = "topofr_r100"

_MODELS_DIR = os.environ.get("FNVR_MODELS_DIR", "/var/lib/fnvr/models/faceid")
_EMB_PATH = os.path.join(_MODELS_DIR, "topofr_r100.onnx")

_lock = threading.Lock()
_emb_session: ort.InferenceSession | None = None


@dataclass
class Detection:
    x: float  # bbox normalised to [0,1] of the input image
    y: float
    w: float
    h: float
    score: float
    embedding: list[float]  # len=512, L2-normalised
    norm: float  # pre-normalisation L2 norm — quality proxy
    roll: float  # degrees, eye-line
    yaw: float  # nose offset in interocular units (proxy, not degrees)


def _load_embedder() -> ort.InferenceSession:
    global _emb_session
    with _lock:
        if _emb_session is None:
            if not os.path.exists(_EMB_PATH):
                raise FileNotFoundError(
                    f"topofr ONNX not found at {_EMB_PATH}; start the "
                    f"pipeline container once to seed the models volume"
                )
            log.info("loading embedder: %s", _EMB_PATH)
            _emb_session = ort.InferenceSession(
                _EMB_PATH, providers=["CPUExecutionProvider"]
            )
    return _emb_session


def embed_aligned(aligned_bgr: np.ndarray) -> tuple[np.ndarray, float]:
    """Embed one 112x112 ArcFace-aligned BGR face. Returns
    (unit-norm 512-d vector, raw pre-normalisation L2 norm)."""
    rgb = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    blob = ((rgb - 127.5) / 127.5).transpose(2, 0, 1)[None, ...]
    sess = _load_embedder()
    raw = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0].astype(np.float32)
    n = float(np.linalg.norm(raw))
    if n < 1e-12:
        return raw, 0.0
    return raw / n, n


def embed_face(img_bgr: np.ndarray, face: scrfd.Face) -> tuple[np.ndarray, float, float, float]:
    """Align + embed one detected face. Returns (vector, norm, roll, yaw)."""
    aligned = align.norm_crop(img_bgr, face.kps)
    vec, n = embed_aligned(aligned)
    roll, yaw = align.pose_proxies(face.kps)
    return vec, n, roll, yaw


def detect_and_embed(
    jpg_bytes: bytes,
    conf_thresh: float = 0.4,
    iou_thresh: float = 0.4,
) -> list[Detection]:
    """Detect all faces in a JPEG and embed each (aligned)."""
    arr = np.frombuffer(jpg_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image bytes")
    src_h, src_w = img.shape[:2]

    results: list[Detection] = []
    for f in scrfd.detect(img, conf_thresh=conf_thresh, iou_thresh=iou_thresh):
        if f.x2 - f.x1 < 8 or f.y2 - f.y1 < 8:
            continue
        vec, n, roll, yaw = embed_face(img, f)
        results.append(
            Detection(
                x=f.x1 / src_w,
                y=f.y1 / src_h,
                w=(f.x2 - f.x1) / src_w,
                h=(f.y2 - f.y1) / src_h,
                score=f.score,
                embedding=vec.tolist(),
                norm=n,
                roll=roll,
                yaw=yaw,
            )
        )
    # Highest confidence first — the upload flow picks index 0 by default.
    results.sort(key=lambda d: d.score, reverse=True)
    return results
