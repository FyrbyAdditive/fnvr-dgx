#!/usr/bin/env python3
"""Fetch Obico's print-failure detection model (offline, models-cache
pattern — see export_topofr.py for why nothing downloads at image
build time).

Model: Obico (ex-The Spaghetti Detective) 2nd-gen failure detector —
the same model their self-hosted server ships (obico-server
ml_api/model/model-weights.onnx.url). Single class "failure",
YOLOv2-lineage, 416x416 input; the ONNX EMBEDS the decode:
  boxes [1, 845, 1, 4]  — normalised x1,y1,x2,y2 in [0,1]
  confs [1, 845, 1]     — per-box class confidence
so post-processing is threshold + NMS only (ported into
apps/ml-worker/fnvr_ml/printmon.py from obico's ml_api/lib/onnx.py —
AGPL-3.0, personal self-hosted use).

Pin:
  url:    https://tsd-pub-static.s3.amazonaws.com/ml-models/model-weights-5a6b1be1fa.onnx
  sha256: 0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa
"""
from __future__ import annotations

import argparse
import hashlib
import urllib.request

URL = "https://tsd-pub-static.s3.amazonaws.com/ml-models/model-weights-5a6b1be1fa.onnx"
SHA256 = "0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="deploy/models-cache/obico_failure.onnx")
    args = ap.parse_args()

    print(f"downloading {URL}")
    urllib.request.urlretrieve(URL, args.out)

    h = hashlib.sha256()
    with open(args.out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    assert h.hexdigest() == SHA256, f"sha mismatch: {h.hexdigest()}"

    import onnx

    m = onnx.load(args.out)
    for o in m.graph.output:
        dims = [d.dim_param or d.dim_value for d in o.type.tensor_type.shape.dim]
        print("output", o.name, dims)
    print(f"obico_failure fetched → {args.out}")


if __name__ == "__main__":
    main()
