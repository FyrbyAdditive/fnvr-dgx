#!/usr/bin/env python3
"""Fetch Obico's print-failure detection model weights (offline,
models-cache pattern — see export_topofr.py for why nothing downloads
at image build time).

IMPORTANT: Obico only refreshes the DARKNET format of its open model
(obico-server ml_api/model/model-weights.darknet.url); their hosted
ONNX was last built 2023-05 and is a generation behind. This script
therefore fetches the darknet weights + cfg and hands off to
convert_obico_darknet.py (parity-verified against Obico's own ONNX)
to produce deploy/models-cache/obico_failure.onnx with the contract
printmon.py + the Triton entry consume:
  boxes [1, 845, 1, 4]  — normalised x1,y1,x2,y2 in [0,1]
  confs [1, 845, 1]     — per-box confidence (single class "failure")
AGPL-3.0 upstream; personal self-hosted use. Measured on real crops
(2026-07-21): the 2025-12 weights score ~3x higher on genuine
spaghetti and dropped the toolhead-cable false-positive floor to 0.

Pins (2025-12-18 "Improved darknet model"):
  weights: https://tsd-pub-static.s3.us-east-1.amazonaws.com/ml-models/model-weights-ef79dacfd0051ab526f3002d5f5f9912.darknet
  sha256:  3e6f7e3f166aa3a0ac08620949df71df853ac4b63af537f116be604bba54b292
  cfg:     obico-server ml_api/model/model.cfg @ master (YOLOv2, 1 class)
Legacy (the 2023 ONNX this replaced):
  https://tsd-pub-static.s3.amazonaws.com/ml-models/model-weights-5a6b1be1fa.onnx
  sha256 0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa
"""
from __future__ import annotations

import argparse
import hashlib
import urllib.request

URL = "https://tsd-pub-static.s3.us-east-1.amazonaws.com/ml-models/model-weights-ef79dacfd0051ab526f3002d5f5f9912.darknet"
SHA256 = "3e6f7e3f166aa3a0ac08620949df71df853ac4b63af537f116be604bba54b292"
CFG_URL = "https://raw.githubusercontent.com/TheSpaghettiDetective/obico-server/master/ml_api/model/model.cfg"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights-out", default="obico_new.darknet")
    ap.add_argument("--cfg-out", default="obico_model.cfg")
    args = ap.parse_args()

    print(f"downloading {URL}")
    urllib.request.urlretrieve(URL, args.weights_out)
    h = hashlib.sha256()
    with open(args.weights_out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    assert h.hexdigest() == SHA256, f"sha mismatch: {h.hexdigest()}"

    print(f"downloading {CFG_URL}")
    urllib.request.urlretrieve(CFG_URL, args.cfg_out)

    print(
        "next: tools/model-prep/convert_obico_darknet.py "
        f"--cfg {args.cfg_out} --weights {args.weights_out} "
        "--out deploy/models-cache/obico_failure.onnx"
    )


if __name__ == "__main__":
    main()
