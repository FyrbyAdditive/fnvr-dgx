#!/usr/bin/env python3
"""Fetch the global ANPR stack at image build time.

- Plate detector: open-image-models yolo-v9-t-*-license-plate-end2end
  (ONNX with EfficientNMS baked in: num_dets/boxes/scores/classes).
- Plate OCR: fast-plate-ocr cct-s-v2-global-model (65+ countries).

Both packages download from their own hubs; we let them, then copy the
artifacts to --out and generate the OCR charset labels file FROM THE
MODEL'S OWN CONFIG (a hand-typed charset produces plausible-but-wrong
plates). A meta.json records slot count / charset / detector input dims
for the entrypoint to render into the nvinfer configs.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import onnx
import yaml


SEARCH_ROOTS = [Path.home() / ".cache", Path.home(), Path("/tmp"),
                Path("/var/tmp")]


def find_one(_root: Path, pattern: str) -> Path:
    """Locate a downloaded artifact wherever the package cached it.

    Different releases of open-image-models / fast-plate-ocr have used
    different cache dirs; search broadly and, on a miss, dump every
    .onnx/.yaml we can see so the build log diagnoses itself.
    """
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        hits = sorted(root.rglob(pattern))
        if hits:
            return hits[0]
    seen = []
    for root in SEARCH_ROOTS:
        if root.exists():
            seen += [str(p) for p in root.rglob("*.onnx")]
            seen += [str(p) for p in root.rglob("*.yaml")]
    raise AssertionError(
        f"no {pattern} under {[str(r) for r in SEARCH_ROOTS]}; "
        f"artifacts visible: {seen}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detector", default="yolo-v9-t-640-license-plate-end2end")
    ap.add_argument("--ocr", default="cct-s-v2-global-model")
    ap.add_argument("--out", default="/opt/fnvr/anpr")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # --- detector -------------------------------------------------------
    from open_image_models import LicensePlateDetector
    LicensePlateDetector(detection_model=args.detector)  # triggers download
    cache = Path.home() / ".cache"
    # The cache DIR uses the model name verbatim but the FILE pluralises
    # "license-plates" — match on the size prefix + end2end instead.
    det_prefix = args.detector.split("-license")[0]  # e.g. yolo-v9-t-640
    det_src = find_one(cache, f"*{det_prefix}*end2end*.onnx")
    det_dst = out / "platedet.onnx"
    shutil.copy(det_src, det_dst)
    dm = onnx.load(str(det_dst))
    d_dims = [d.dim_value for d in dm.graph.input[0].type.tensor_type.shape.dim]
    det_meta = {
        "input_w": d_dims[-1], "input_h": d_dims[-2],
        "outputs": [o.name for o in dm.graph.output],
    }

    # --- OCR ------------------------------------------------------------
    from fast_plate_ocr import LicensePlateRecognizer
    LicensePlateRecognizer(args.ocr)  # triggers download of onnx + config
    # Cache DIR uses the hyphenated model name; FILES use underscores
    # and drop the "-model" suffix (cct_s_v2_global.onnx). Glob with a
    # separator-agnostic pattern derived from the name's tokens.
    tokens = [t for t in args.ocr.replace("-model", "").split("-") if t]
    loose = "*" + "*".join(tokens) + "*"
    loose = loose.replace("*s*", "*")  # single-letter tokens over-match
    ocr_src = find_one(cache, f"{loose}.onnx")
    ocr_dst = out / "plateocr.onnx"
    shutil.copy(ocr_src, ocr_dst)

    # The CCT model's input is NHWC [B,64,128,3]; nvinfer's NHWC support
    # is version-temperamental (DS 9.1 rejected it against a built
    # engine). Rewrite the graph to a standard NCHW input with an
    # inserted Transpose so every DS version treats it as a normal
    # 3-channel network.
    om0 = onnx.load(str(ocr_dst))
    g = om0.graph
    inp = g.input[0]
    d = inp.type.tensor_type.shape.dim
    if len(d) == 4 and d[3].dim_value == 3:  # NHWC confirmed
        from onnx import helper
        orig_name = inp.name
        nhwc_name = orig_name + "_nhwc"
        # Rewire consumers of the original input to the transposed tensor.
        for node in g.node:
            node.input[:] = [nhwc_name if i == orig_name else i
                             for i in node.input]
        h, w = d[1].dim_value, d[2].dim_value
        new_in = helper.make_tensor_value_info(
            orig_name, onnx.TensorProto.FLOAT, ["batch", 3, h, w])
        g.input.remove(inp)
        g.input.insert(0, new_in)
        tr = helper.make_node("Transpose", [orig_name], [nhwc_name],
                              perm=[0, 2, 3, 1], name="fnvr_nchw_to_nhwc")
        g.node.insert(0, tr)
        onnx.checker.check_model(om0)
        onnx.save(om0, str(ocr_dst))
        print("plateocr: wrapped NHWC input as NCHW+Transpose")
    cfg_src = None
    for pat in (f"{loose}config*.yaml", f"{loose}config*.yml",
                f"{loose}.yaml"):
        try:
            cfg_src = find_one(cache, pat)
            break
        except AssertionError:
            continue
    assert cfg_src is not None, "no OCR config yaml found in cache"
    cfg = yaml.safe_load(cfg_src.read_text())
    alphabet = cfg["alphabet"]
    max_slots = int(cfg["max_plate_slots"])
    pad_char = cfg.get("pad_char", "_")

    om = onnx.load(str(ocr_dst))
    o_dims = [d.dim_value for d in om.graph.input[0].type.tensor_type.shape.dim]

    # Charset labels file, one char per line, IN MODEL ORDER.
    (out / "plateocr.labels").write_text("\n".join(list(alphabet)) + "\n")

    meta = {
        "detector": det_meta,
        "ocr": {
            "input_dims": o_dims,
            "outputs": [o.name for o in om.graph.output],
            "alphabet": alphabet,
            "alphabet_len": len(alphabet),
            "max_plate_slots": max_slots,
            "pad_char": pad_char,
        },
    }
    (out / "anpr.meta.json").write_text(json.dumps(meta, indent=1))
    print("plate models ready:", json.dumps(meta))


if __name__ == "__main__":
    main()
