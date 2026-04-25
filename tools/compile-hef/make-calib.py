"""
Build a calibration set for Hailo's INT8 quantisation step.

Hailo's compiler walks the network with a representative batch of
input frames, observes activation distributions per layer, and
chooses INT8 scale factors that minimise quantisation error against
the FP32 reference. The calibration data needs to look like real
deployed-time inputs — same camera angles, same lighting, same
object mix — or the resulting HEF underperforms on the actual cameras.

We pull from the dataset's `images/train/` (which is a mirror of the
Orin's flag-collected frames). Random sample is fine because the
flag UI naturally biases toward "interesting" frames; we don't need
explicit balancing.

Output: `calib/000000.jpg` ... `calib/000{N-1}.jpg`, each resized +
letterboxed to imgsz × imgsz so they hit the model the same shape
the production pipeline does.
"""
from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

import cv2
import numpy as np


def letterbox(img: np.ndarray, target: int) -> np.ndarray:
    """Resize to fit inside `target × target` keeping aspect ratio,
    pad with grey 114 — same convention DeepStream's nvinfer PGIE
    uses, so calibration sees the same input shape production does.
    """
    h, w = img.shape[:2]
    scale = min(target / w, target / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((target, target, 3), 114, dtype=np.uint8)
    dx = (target - nw) // 2
    dy = (target - nh) // 2
    canvas[dy:dy + nh, dx:dx + nw] = resized
    return canvas


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/work/dataset/images/train",
                    help="root with the YOLO training frames (jpg/png)")
    ap.add_argument("--dst", default="/work/calib",
                    help="where to write the resized calibration JPEGs")
    ap.add_argument("--n", type=int, default=1024,
                    help="number of calibration images (Hailo recommends 256-2048)")
    ap.add_argument("--imgsz", type=int, default=640,
                    help="must match the trained model's input shape")
    ap.add_argument("--seed", type=int, default=42,
                    help="deterministic sampling so re-runs use the same set")
    args = ap.parse_args()

    src = Path(args.src)
    dst = Path(args.dst)
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)

    pool = sorted(p for p in src.iterdir()
                  if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if not pool:
        raise SystemExit(f"no images under {src}")
    random.seed(args.seed)
    sample = random.sample(pool, k=min(args.n, len(pool)))
    print(f"sampling {len(sample)} of {len(pool)} images from {src}")

    for i, p in enumerate(sample):
        img = cv2.imread(str(p))
        if img is None:
            continue
        out = letterbox(img, args.imgsz)
        cv2.imwrite(str(dst / f"{i:06d}.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"wrote {len(sample)} calibration frames to {dst}")


if __name__ == "__main__":
    main()
