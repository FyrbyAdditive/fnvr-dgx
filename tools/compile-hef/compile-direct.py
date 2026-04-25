"""
Direct Hailo Dataflow Compiler driver — bypasses `hailomz compile`.

The hailomz CLI's bundled-script loader hits a pyparsing parseAll bug
on multi-line .alls files in the DFC 3.33.1 + hailo_model_zoo v2.17
combo we have available. To work around this, we drive the compiler's
Python API directly using `append=True` so we feed the parser one
command at a time — exactly what the broken multi-line path is
trying to do, but actually working.

Steps:
  1. Translate ONNX → HAR (HailoRT archive — DFC's IR)
  2. Apply the model script commands one at a time:
       - normalisation
       - nms_postprocess (with our patched JSON)
  3. Optimise (INT8 quantise) using the calibration directory
  4. Compile to HEF for hailo8l

Args (positional, in order): onnx_path version_name calib_dir num_classes
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from hailo_sdk_client import ClientRunner


def load_calib_array(calib_dir: Path, n: int = 256, imgsz: int = 640) -> np.ndarray:
    """Load up to `n` JPEGs from `calib_dir`, return as
    [N, H, W, 3] uint8 ndarray. The compiler's calibrate() expects
    pre-letterboxed frames at the model's input resolution."""
    files = sorted(p for p in calib_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if len(files) > n:
        files = files[:n]
    arr = np.zeros((len(files), imgsz, imgsz, 3), dtype=np.uint8)
    for i, p in enumerate(files):
        img = Image.open(p).convert("RGB").resize((imgsz, imgsz), Image.BILINEAR)
        arr[i] = np.array(img, dtype=np.uint8)
    return arr


def main() -> None:
    if len(sys.argv) != 5:
        sys.exit(f"usage: {sys.argv[0]} <onnx_path> <version_name> <calib_dir> <num_classes>")
    onnx_path = Path(sys.argv[1])
    version = sys.argv[2]
    calib_dir = Path(sys.argv[3])
    num_classes = int(sys.argv[4])

    out_dir = Path("/work/out")
    out_dir.mkdir(parents=True, exist_ok=True)
    har_path = out_dir / f"{version}.har"
    hef_path = out_dir / f"{version}.hef"

    nms_json_src = Path("/opt/hailo/hailo_model_zoo/hailo_model_zoo/cfg/postprocess_config/yolov11l_nms_config.json")
    nms_json_dst = Path("/tmp/fnvr_nms.json")
    with nms_json_src.open() as f:
        nms_cfg = json.load(f)
    nms_cfg["classes"] = num_classes
    with nms_json_dst.open("w") as f:
        json.dump(nms_cfg, f, indent=2)
    print(f"=== patched NMS config: classes={num_classes} -> {nms_json_dst}")

    print(f"=== translating ONNX -> HAR ===")
    runner = ClientRunner(hw_arch="hailo8l")
    # Map the network's input + output node names. yolov11l with NMS-
    # off export has 1 input + 6 outputs (3 scales × cls/box).
    runner.translate_onnx_model(
        str(onnx_path),
        version,  # network name
        start_node_names=["images"],
        end_node_names=[
            "/model.23/cv2.0/cv2.0.2/Conv",
            "/model.23/cv3.0/cv3.0.2/Conv",
            "/model.23/cv2.1/cv2.1.2/Conv",
            "/model.23/cv3.1/cv3.1.2/Conv",
            "/model.23/cv2.2/cv2.2.2/Conv",
            "/model.23/cv3.2/cv3.2.2/Conv",
        ],
        net_input_shapes={"images": [1, 3, 640, 640]},
    )
    runner.save_har(str(har_path))
    print(f"=== HAR -> {har_path}")

    print("=== applying normalisation via single-command script ===")
    runner.load_model_script(
        "normalization1 = normalization([0.0, 0.0, 0.0], [255.0, 255.0, 255.0])\n"
    )

    print("=== injecting nms_postprocess directly via SDK API ===")
    # Construct an NMSPostprocessCommand and apply() it on the HN.
    # This bypasses the .alls parser entirely — the parser has a
    # pyparsing bug at this DFC × model_zoo version that breaks
    # both bundled and user-supplied multi-line scripts. The Python
    # API takes the same args directly.
    from hailo_sdk_client.sdk_backend.script_parser.nms_postprocess_command import (
        NMSPostprocessCommand,
    )
    from hailo_model_optimization.acceleras.utils.acceleras_definitions import (
        NMSProperties,
    )
    args_dict = {
        NMSProperties.CONFIG_PATH: str(nms_json_dst),
        NMSProperties.META_ARCH: "yolov8",
        NMSProperties.ENGINE: "cpu",
    }
    nms_cmd = NMSPostprocessCommand(args_dict, script_path=str(har_path))
    # add_command bypasses the multi-statement parser entirely.
    runner._sdk_backend._script_parser._commands.append(nms_cmd)

    print(f"=== loading calibration data from {calib_dir} ===")
    calib = load_calib_array(calib_dir, n=256, imgsz=640)
    print(f"=== calibration array shape: {calib.shape} dtype: {calib.dtype}")

    print("=== optimising (INT8 quantisation, this takes ~5-15 min) ===")
    runner.optimize(calib)
    runner.save_har(str(har_path))

    print("=== compiling to HEF ===")
    hef = runner.compile()
    with hef_path.open("wb") as f:
        f.write(hef)
    print(f"=== HEF written: {hef_path} ({hef_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
