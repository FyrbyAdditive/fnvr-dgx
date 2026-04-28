"""
Convert a directory of letterboxed JPEGs into a single .npy tensor
suitable for `python -m modelopt.onnx.quantization
--calibration_data=...`.

Modelopt's calibration loader expects a single numpy file with shape
[N, C, H, W] in float32, normalised to the model's input range. For
yolo26 that's [N, 3, 640, 640] in [0, 1] (the model's net-scale-factor
in nvinfer is 1/255).

We reuse the calibration JPEGs already produced by
tools/compile-hef/make-calib.py (which are letterboxed to 640x640
with 114-fill padding — the same convention DeepStream uses).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/work/calib",
                    help="dir of letterboxed JPEGs")
    ap.add_argument("--dst", default="/work/calib.npy")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--limit", type=int, default=0,
                    help="0 = use all images; otherwise cap at this many")
    args = ap.parse_args()

    src = Path(args.src)
    files = sorted(p for p in src.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if args.limit > 0:
        files = files[:args.limit]
    if not files:
        raise SystemExit(f"no calibration images found under {src}")

    n = len(files)
    print(f"loading {n} images @ {args.imgsz}x{args.imgsz}...")
    arr = np.zeros((n, 3, args.imgsz, args.imgsz), dtype=np.float32)
    for i, p in enumerate(files):
        img = cv2.imread(str(p))
        if img is None:
            raise SystemExit(f"failed to read {p}")
        if img.shape[:2] != (args.imgsz, args.imgsz):
            raise SystemExit(
                f"{p}: expected {args.imgsz}x{args.imgsz}, got {img.shape[:2]}. "
                "Re-letterbox via tools/compile-hef/make-calib.py first.")
        # BGR -> RGB, HWC -> CHW, [0,255] -> [0,1] float32. Matches
        # nvinfer's net-scale-factor=1/255 + model-color-format=0
        # (RGB) in deploy/config/nvinfer/yolo26.txt.template.
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        chw = rgb.transpose(2, 0, 1)  # H,W,C -> C,H,W
        arr[i] = chw.astype(np.float32) / 255.0

    print(f"writing {arr.shape} {arr.dtype} -> {args.dst}")
    np.save(args.dst, arr)
    print("done")


if __name__ == "__main__":
    main()
