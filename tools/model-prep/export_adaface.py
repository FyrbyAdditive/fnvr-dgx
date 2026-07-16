#!/usr/bin/env python3
"""Export AdaFace IR-101 (WebFace12M) to ONNX at image build time.

Source: minchul/cvlface_adaface_ir101_webface12m on Hugging Face (the
model author's CVLface packaging; AutoModel + trust_remote_code).

Contract (must match deploy/config/nvinfer/adaface.txt):
  input : 1x3x112x112 RGB, normalised (x/255 - 0.5)/0.5
          → nvinfer: net-scale-factor=0.0078431373, offsets=127.5;127.5;127.5,
            model-color-format=0 (RGB)
  output: 512-d embedding (drop-in for the pgvector vector(512) schema;
          NOT comparable with ArcFace R100 embeddings — the
          face_embeddings.model column keeps the spaces apart).
"""
from __future__ import annotations

import argparse

import torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="minchul/cvlface_adaface_ir101_webface12m")
    ap.add_argument("--out", default="/opt/fnvr/faceid/adaface.onnx")
    args = ap.parse_args()

    # CVLface's remote code imports its own repo-relative `models`
    # package, which transformers' single-file dynamic-module cache
    # can't resolve. Snapshot the whole repo and load from the local
    # directory (the documented CVLface pattern).
    import sys

    from huggingface_hub import snapshot_download
    from transformers import AutoModel

    local = snapshot_download(args.repo)
    sys.path.insert(0, local)
    # The wrapper opens 'pretrained_model/model.yaml' relative to CWD —
    # CVLface's loader convention is to run from inside the repo.
    import os
    out_abs = os.path.abspath(args.out)
    os.chdir(local)
    model = AutoModel.from_pretrained(local, trust_remote_code=True)
    model.eval()
    args.out = out_abs

    dummy = torch.randn(1, 3, 112, 112)
    with torch.no_grad():
        out = model(dummy)
    emb = out[0] if isinstance(out, (tuple, list)) else out
    assert emb.shape[-1] == 512, f"expected 512-d embedding, got {emb.shape}"

    class Wrapper(torch.nn.Module):
        """Flatten whatever the CVLface wrapper returns to a plain tensor."""
        def __init__(self, m):
            super().__init__()
            self.m = m
        def forward(self, x):
            y = self.m(x)
            return y[0] if isinstance(y, (tuple, list)) else y

    torch.onnx.export(
        Wrapper(model), dummy, args.out,
        input_names=["input"], output_names=["embedding"],
        opset_version=17,
        dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}},
        dynamo=False,
    )
    print(f"adaface exported to {args.out} (512-d)")


if __name__ == "__main__":
    main()
