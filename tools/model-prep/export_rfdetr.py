#!/usr/bin/env python3
"""Export RF-DETR variants to nvinfer-ready ONNX at image build time.

Produces, per variant, under --out:
  <variant>.onnx       — with ImageNet mean/std normalisation BAKED into
                         the graph (nvinfer has a single net-scale-factor
                         and per-channel offsets, but no per-channel std),
                         so the pipeline feeds raw 0-255 RGB.
  <variant>.meta.json  — {"input_w","input_h","num_classes","labels":[...]}
                         consumed by the entrypoint to render the nvinfer
                         template ($RFDETR_DIMS/$NUM_CLASSES) and write
                         labels.txt.

Class space: whatever the rfdetr package reports (COCO_CLASSES). The
labels file is generated from the SAME source that trained the head, so
names always match indices — no hand-maintained mapping. If index 0 is
not 'person', the entrypoint refuses to enable the face SGIE chain for
the rfdetr family (scrfd.txt operates on class-id 0).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper


def bake_normalisation(model: onnx.ModelProto) -> onnx.ModelProto:
    """Prepend x' = (x/255 - mean)/std as (x - mean*255) * 1/(std*255)."""
    graph = model.graph
    inp = graph.input[0]
    name = inp.name
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32) * 255.0
    inv_std = 1.0 / (np.array([0.229, 0.224, 0.225], dtype=np.float32) * 255.0)

    mean_init = helper.make_tensor(
        "fnvr_mean", TensorProto.FLOAT, [1, 3, 1, 1], mean.flatten().tolist())
    std_init = helper.make_tensor(
        "fnvr_inv_std", TensorProto.FLOAT, [1, 3, 1, 1], inv_std.flatten().tolist())
    graph.initializer.extend([mean_init, std_init])

    sub = helper.make_node("Sub", [name, "fnvr_mean"], ["fnvr_centred"],
                           name="fnvr_sub_mean")
    mul = helper.make_node("Mul", ["fnvr_centred", "fnvr_inv_std"],
                           ["fnvr_normed"], name="fnvr_mul_std")
    # Rewire every consumer of the raw input to the normalised tensor.
    for node in graph.node:
        node.input[:] = ["fnvr_normed" if i == name else i for i in node.input]
    graph.node.insert(0, mul)
    graph.node.insert(0, sub)
    return model


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", nargs="+", default=["base", "medium"])
    ap.add_argument("--out", default="/opt/fnvr/rfdetr")
    args = ap.parse_args()

    import rfdetr  # noqa: F401  (heavy import kept out of --help)
    from rfdetr.util.coco_classes import COCO_CLASSES  # type: ignore

    # COCO_CLASSES may be a dict {id: name} (sparse 91-space) or a list.
    if isinstance(COCO_CLASSES, dict):
        max_id = max(COCO_CLASSES)
        labels = [COCO_CLASSES.get(i, f"class_{i}") for i in range(max_id + 1)]
    else:
        labels = list(COCO_CLASSES)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    ctor = {
        "nano":   "RFDETRNano",
        "small":  "RFDETRSmall",
        "medium": "RFDETRMedium",
        "base":   "RFDETRBase",
        "large":  "RFDETRLarge",
    }
    for v in args.variants:
        cls = getattr(rfdetr, ctor[v])
        model = cls()
        # rfdetr's export writes an onnx into its output dir. Kwarg
        # surface varies across rfdetr releases — fall back gracefully.
        export_dir = out_dir / f"export-{v}"
        export_dir.mkdir(parents=True, exist_ok=True)
        try:
            model.export(format="onnx", output_dir=str(export_dir))
        except TypeError:
            model.export(output_dir=str(export_dir))
        exported = sorted(export_dir.glob("*.onnx"))
        assert exported, f"rfdetr export produced no onnx for {v}"
        m = onnx.load(str(exported[0]))

        dims = [d.dim_value for d in m.graph.input[0].type.tensor_type.shape.dim]
        assert len(dims) == 4, f"unexpected input rank for {v}: {dims}"
        _, _, in_h, in_w = dims

        m = bake_normalisation(m)
        onnx.checker.check_model(m)
        onnx.save(m, str(out_dir / f"rfdetr-{v}.onnx"))

        meta = {
            "input_w": in_w,
            "input_h": in_h,
            "num_classes": len(labels),
            "labels": labels,
            "outputs": [o.name for o in m.graph.output],
        }
        (out_dir / f"rfdetr-{v}.meta.json").write_text(json.dumps(meta, indent=1))
        print(f"exported rfdetr-{v}: {in_w}x{in_h}, {len(labels)} classes, "
              f"outputs={meta['outputs']}")
        # Free the checkpoint dir; the baked onnx is all we ship.
        import shutil
        shutil.rmtree(export_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
