"""ONNX-runtime inference helpers for the ml-worker sidecar.

Runs the same RetinaFace (face_detector.onnx) + AdaFace IR-101
(adaface.onnx) models the live pipeline uses, but on CPU via
onnxruntime. Used by the photo-upload enrolment endpoint; by
design it is *not* on the hot path for live frames — the pipeline
handles those via DeepStream.

Models are loaded lazily (on first call) so the container starts
even if the model files haven't been seeded onto the shared volume
yet by the pipeline image.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Iterable

import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger(__name__)

_MODELS_DIR = os.environ.get("FNVR_MODELS_DIR", "/var/lib/fnvr/models/faceid")
_DET_PATH = os.path.join(_MODELS_DIR, "face_detector.onnx")
_EMB_PATH = os.path.join(_MODELS_DIR, "adaface.onnx")

# RetinaFace MobileNet-0.25 priors. Copied verbatim from biubug6's
# Pytorch_Retinaface/data/config.py — the exported ONNX we ship is
# that model with outputs renamed bbox/conf/lmk.
_MIN_SIZES = [[16, 32], [64, 128], [256, 512]]
_STEPS = [8, 16, 32]
_VARIANCE = (0.1, 0.2)
_INPUT_SIZE = 640          # NCHW square
_DET_MEANS = (104.0, 117.0, 123.0)  # BGR, subtracted, no scale
_EMB_INPUT_SIZE = 112
_EMB_MEANS = 127.5
_EMB_SCALE = 1.0 / 128.0

_session_lock = threading.Lock()
_det_session: ort.InferenceSession | None = None
_emb_session: ort.InferenceSession | None = None
_priors_cache: np.ndarray | None = None


@dataclass
class Detection:
    x: float  # normalised to [0,1] of the input JPEG
    y: float
    w: float
    h: float
    score: float
    embedding: list[float]  # len=512, L2-normalised


def _load_detector() -> ort.InferenceSession:
    global _det_session
    with _session_lock:
        if _det_session is None:
            if not os.path.exists(_DET_PATH):
                raise FileNotFoundError(
                    f"face detector ONNX not found at {_DET_PATH}. "
                    f"Ensure the pipeline container has started at least once "
                    f"to seed /var/lib/fnvr/models/faceid/."
                )
            log.info("loading detector: %s", _DET_PATH)
            _det_session = ort.InferenceSession(
                _DET_PATH, providers=["CPUExecutionProvider"]
            )
    return _det_session


def _load_embedder() -> ort.InferenceSession:
    global _emb_session
    with _session_lock:
        if _emb_session is None:
            if not os.path.exists(_EMB_PATH):
                raise FileNotFoundError(
                    f"adaface ONNX not found at {_EMB_PATH}"
                )
            log.info("loading embedder: %s", _EMB_PATH)
            _emb_session = ort.InferenceSession(
                _EMB_PATH, providers=["CPUExecutionProvider"]
            )
    return _emb_session


def _anchor_priors() -> np.ndarray:
    """Generate RetinaFace anchor priors once at (640, 640)."""
    global _priors_cache
    if _priors_cache is not None:
        return _priors_cache
    priors = []
    for k, step in enumerate(_STEPS):
        fm_h = _INPUT_SIZE // step
        fm_w = _INPUT_SIZE // step
        min_sizes_k = _MIN_SIZES[k]
        for i in range(fm_h):
            for j in range(fm_w):
                for min_size in min_sizes_k:
                    s_kx = min_size / _INPUT_SIZE
                    s_ky = min_size / _INPUT_SIZE
                    cx = (j + 0.5) * step / _INPUT_SIZE
                    cy = (i + 0.5) * step / _INPUT_SIZE
                    priors.append([cx, cy, s_kx, s_ky])
    _priors_cache = np.asarray(priors, dtype=np.float32)
    return _priors_cache


def _decode(locs: np.ndarray, priors: np.ndarray) -> np.ndarray:
    """Decode bbox regressions into [xmin, ymin, xmax, ymax] in [0,1]."""
    boxes = np.concatenate(
        (
            priors[:, :2] + locs[:, :2] * _VARIANCE[0] * priors[:, 2:],
            priors[:, 2:] * np.exp(locs[:, 2:] * _VARIANCE[1]),
        ),
        axis=1,
    )
    boxes[:, :2] -= boxes[:, 2:] / 2
    boxes[:, 2:] += boxes[:, :2]
    return boxes


def _nms(dets: np.ndarray, iou_thresh: float) -> list[int]:
    """Plain NMS. dets rows: [xmin, ymin, xmax, ymax, score]."""
    if len(dets) == 0:
        return []
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        inds = np.where(ovr <= iou_thresh)[0]
        order = order[inds + 1]
    return keep


def _preprocess_det(jpg_bytes: bytes) -> tuple[np.ndarray, int, int]:
    arr = np.frombuffer(jpg_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image bytes")
    src_h, src_w = img.shape[:2]
    # Letterbox into INPUT_SIZE x INPUT_SIZE preserving aspect.
    # RetinaFace priors assume square input; this is the simplest
    # way to respect that without retraining priors.
    scale = _INPUT_SIZE / max(src_w, src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    resized = cv2.resize(img, (new_w, new_h))
    canvas = np.zeros((_INPUT_SIZE, _INPUT_SIZE, 3), dtype=np.uint8)
    canvas[:new_h, :new_w] = resized
    blob = canvas.astype(np.float32)
    blob -= np.array(_DET_MEANS, dtype=np.float32)
    blob = blob.transpose(2, 0, 1)[None, ...]  # HWC BGR -> 1CHW
    return blob, src_w, src_h


def _preprocess_emb(face_bgr: np.ndarray) -> np.ndarray:
    # AdaFace (CVLface export) consumes RGB, (x/255 - 0.5)/0.5 — the
    # same scale as the old ArcFace path but RGB channel order. This
    # MUST match adaface.txt (model-color-format=0) or ml-worker
    # enrolments and pipeline embeddings drift apart.
    resized = cv2.resize(face_bgr, (_EMB_INPUT_SIZE, _EMB_INPUT_SIZE))
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    blob = rgb.astype(np.float32)
    blob = (blob - _EMB_MEANS) * _EMB_SCALE
    blob = blob.transpose(2, 0, 1)[None, ...]
    return blob


def _l2norm(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        return v
    return v / n


def detect_and_embed(
    jpg_bytes: bytes,
    conf_thresh: float = 0.5,
    iou_thresh: float = 0.4,
) -> list[Detection]:
    """Detect faces in a single JPEG, return bbox + ArcFace embedding."""
    det = _load_detector()
    emb = _load_embedder()

    blob, src_w, src_h = _preprocess_det(jpg_bytes)
    det_out = det.run(None, {det.get_inputs()[0].name: blob})
    # Exported ONNX outputs were renamed to bbox / conf / lmk. Order
    # in the output list follows the graph's output declaration but
    # we look them up by name to stay safe.
    by_name = {det.get_outputs()[i].name: det_out[i] for i in range(len(det_out))}
    locs = by_name.get("bbox", det_out[0])[0]
    conf = by_name.get("conf", det_out[1])[0]
    # conf is already softmaxed in biubug6's forward(); [:, 1] is the
    # face probability.
    priors = _anchor_priors()
    boxes = _decode(locs, priors)  # [xmin, ymin, xmax, ymax] normalised
    scores = conf[:, 1]

    keep_mask = scores >= conf_thresh
    boxes = boxes[keep_mask]
    scores = scores[keep_mask]
    if len(boxes) == 0:
        return []
    dets = np.concatenate((boxes, scores[:, None]), axis=1)
    keep = _nms(dets, iou_thresh)
    dets = dets[keep]

    # Unletterbox back to source-image coords. The model saw a
    # square canvas with the image top-left; we only need to
    # renormalise x/y by how much of the canvas the source took.
    used_w = min(1.0, src_w / max(src_w, src_h))
    used_h = min(1.0, src_h / max(src_w, src_h))

    # Decode the full-resolution crop for embedding.
    arr = np.frombuffer(jpg_bytes, dtype=np.uint8)
    full = cv2.imdecode(arr, cv2.IMREAD_COLOR)

    results: list[Detection] = []
    for row in dets:
        xmin, ymin, xmax, ymax, score = row
        # Clamp to [0, 1] within the used portion of the canvas.
        xmin = max(0.0, min(used_w, xmin))
        xmax = max(0.0, min(used_w, xmax))
        ymin = max(0.0, min(used_h, ymin))
        ymax = max(0.0, min(used_h, ymax))
        if xmax - xmin < 1e-3 or ymax - ymin < 1e-3:
            continue
        # Rescale to source image coords.
        sx0 = int((xmin / used_w) * src_w)
        sy0 = int((ymin / used_h) * src_h)
        sx1 = int((xmax / used_w) * src_w)
        sy1 = int((ymax / used_h) * src_h)
        sx1 = max(sx1, sx0 + 1)
        sy1 = max(sy1, sy0 + 1)
        crop = full[sy0:sy1, sx0:sx1]
        if crop.size == 0:
            continue
        emb_blob = _preprocess_emb(crop)
        emb_out = emb.run(None, {emb.get_inputs()[0].name: emb_blob})[0][0]
        vec = _l2norm(emb_out.astype(np.float32))

        # Return bbox normalised to source image.
        results.append(
            Detection(
                x=sx0 / src_w,
                y=sy0 / src_h,
                w=(sx1 - sx0) / src_w,
                h=(sy1 - sy0) / src_h,
                score=float(score),
                embedding=vec.tolist(),
            )
        )
    # Highest confidence first — the upload flow picks index 0 by
    # default.
    results.sort(key=lambda d: d.score, reverse=True)
    return results


def embed_vectors_only(face_crops_bgr: Iterable[np.ndarray]) -> list[list[float]]:
    """Batch embed a list of pre-cropped face BGR arrays. Used by
    future fine-tune / shadow-mode paths."""
    emb = _load_embedder()
    out: list[list[float]] = []
    for crop in face_crops_bgr:
        blob = _preprocess_emb(crop)
        vec = emb.run(None, {emb.get_inputs()[0].name: blob})[0][0]
        out.append(_l2norm(vec.astype(np.float32)).tolist())
    return out
