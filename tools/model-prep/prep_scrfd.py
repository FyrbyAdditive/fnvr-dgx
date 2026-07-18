#!/usr/bin/env python3
"""Prepare SCRFD-10G-bnkps ONNX for nvinfer + ml-worker.

Renames the graph's numeric output names to stride-tagged ones so the
nvinfer config (deploy/config/nvinfer/scrfd.txt.template) and both
parsers (C++ nvdsparse_scrfd.cpp, python fnvr_ml/scrfd.py) can bind
by name instead of positional guesswork. Run OFFLINE like
export_topofr.py; the result lives in deploy/models-cache/ (gitignored,
rsync-deployed) and is seeded onto the models volume by the pipeline
entrypoint.

Source (pin):
  scrfd_10g_bnkps.onnx — insightface SCRFD release (ICLR'22), via the
  LPDoctor/insightface HF mirror.
  sha256 (upstream): 5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91
  licence: insightface pretrained models are non-commercial research
  use — fine for this personal deployment (docs/architecture/face-id.md).

Output order in the source graph is [score, bbox, kps] × [s8, s16, s32]
verified by shape: at 640x640, stride 8 → 80*80*2=12800 rows, 16 → 3200,
32 → 800; second dim 1=score, 4=bbox distances, 10=5 keypoints.

Each output is also reshaped from (N, C) to (1, N, C): DeepStream's
explicit-batch nvinfer treats binding dim0 as the batch dimension, so
a batchless (12800, 1) output makes it size the host buffer for ONE
element and the parser reads garbage past it (2026-07-18 incident:
impossible >1 confidences + face crops framing torsos). The leading
1 restores the contract the old RetinaFace export satisfied.
"""
from __future__ import annotations

import argparse

import onnx
from onnx import TensorProto, helper

# Rows-at-640 → stride; cols → tensor kind.
STRIDE_BY_ROWS = {12800: 8, 3200: 16, 800: 32}
KIND_BY_COLS = {1: "score", 4: "bbox", 10: "kps"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default="deploy/models-cache/scrfd_10g_bnkps.onnx")
    args = ap.parse_args()

    m = onnx.load(args.src)
    rename: dict[str, str] = {}
    shapes: dict[str, tuple[int, int]] = {}
    for o in m.graph.output:
        dims = [d.dim_value for d in o.type.tensor_type.shape.dim]
        assert len(dims) == 2, f"unexpected output rank for {o.name}: {dims}"
        stride = STRIDE_BY_ROWS[dims[0]]
        kind = KIND_BY_COLS[dims[1]]
        rename[o.name] = f"{kind}_{stride}"
        shapes[f"{kind}_{stride}"] = (dims[0], dims[1])

    assert len(rename) == 9, f"expected 9 outputs, got {len(rename)}"
    # Rename the internal producers to <name>_flat …
    flat = {old: f"{new}_flat" for old, new in rename.items()}
    for node in m.graph.node:
        node.output[:] = [flat.get(x, x) for x in node.output]
        node.input[:] = [flat.get(x, x) for x in node.input]
    # … then append a Reshape (N,C) → (1,N,C) feeding each graph output.
    del m.graph.output[:]
    for old, new in rename.items():
        n, c = shapes[new]
        shape_name = f"{new}_shape"
        m.graph.initializer.append(
            helper.make_tensor(shape_name, TensorProto.INT64, [3], [1, n, c])
        )
        m.graph.node.append(
            helper.make_node("Reshape", [f"{new}_flat", shape_name], [new],
                             name=f"reshape_{new}")
        )
        m.graph.output.append(
            helper.make_tensor_value_info(new, TensorProto.FLOAT, [1, n, c])
        )

    onnx.checker.check_model(m)
    onnx.save(m, args.out)
    print(f"scrfd prepped → {args.out}: {sorted(rename.values())} (batched 1xNxC)")


if __name__ == "__main__":
    main()
