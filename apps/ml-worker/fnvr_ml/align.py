"""Face alignment — THE canonical implementation for the whole system.

Every TopoFR embedding in fnvr, live or uploaded, passes through
norm_crop() here: 5-point similarity transform onto the ArcFace
112x112 template. Embeddings from unaligned crops are a different,
worse space — that was the core defect of the pre-2026 face stack
(docs/architecture/face-id.md).
"""
from __future__ import annotations

import math

import cv2
import numpy as np

# ArcFace canonical 112x112 landmark template (insightface norm_crop):
# left eye, right eye, nose tip, left mouth corner, right mouth corner.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Umeyama least-squares similarity (rotation+scale+translation),
    returned as a 2x3 warpAffine matrix. numpy-only (no skimage dep)."""
    src = src.astype(np.float64)
    dst = dst.astype(np.float64)
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_c = src - src_mean
    dst_c = dst - dst_mean
    cov = dst_c.T @ src_c / src.shape[0]
    u, s, vt = np.linalg.svd(cov)
    d = np.sign(np.linalg.det(u) * np.linalg.det(vt))
    diag = np.diag([1.0, d])
    rot = u @ diag @ vt
    src_var = (src_c**2).sum() / src.shape[0]
    scale = (s * np.diag(diag)).sum() / src_var
    m = np.zeros((2, 3), dtype=np.float64)
    m[:2, :2] = scale * rot
    m[:, 2] = dst_mean - scale * rot @ src_mean
    return m.astype(np.float32)


def norm_crop(img_bgr: np.ndarray, kps5: np.ndarray, size: int = 112) -> np.ndarray:
    """Warp a face to the aligned template given its 5 landmarks
    (pixel coords in img_bgr). Returns size x size BGR."""
    m = similarity_transform(np.asarray(kps5, dtype=np.float32), ARCFACE_DST)
    return cv2.warpAffine(img_bgr, m, (size, size), borderValue=0.0)


def pose_proxies(kps5: np.ndarray) -> tuple[float, float]:
    """Cheap (roll_deg, yaw_proxy) from the 5 points. roll is the eye-line
    angle in degrees; yaw_proxy is the nose's horizontal offset from the
    eye midpoint in interocular units (~0 frontal, |>0.35| strongly
    turned, sign = direction). Good enough to gate enrolment quality —
    not a real head-pose estimate."""
    k = np.asarray(kps5, dtype=np.float32)
    le, re, nose = k[0], k[1], k[2]
    roll = math.degrees(math.atan2(float(re[1] - le[1]), float(re[0] - le[0])))
    inter = float(np.linalg.norm(re - le))
    if inter < 1e-6:
        return roll, 0.0
    yaw = float(((le[0] + re[0]) / 2.0 - nose[0]) / inter)
    return roll, yaw
