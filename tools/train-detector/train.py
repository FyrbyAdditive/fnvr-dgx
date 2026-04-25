"""
Fine-tune yolov11l on the fnvr-collected YOLO dataset.

Inputs (mounted into the container at /work):
  - dataset/dataset.yaml + dataset/images/{train,val}/ + dataset/labels/{train,val}/
    These come straight off the Orin via pull-dataset.sh.

Outputs:
  - runs/fnvr-vN/weights/best.pt
  - runs/fnvr-vN/weights/best.onnx     <- this is what tools/compile-hef/ consumes

The ONNX export deliberately uses opset 11, no dynamic axes, FP32
weights and onnxsim simplification. Hailo's Dataflow Compiler is
fragile about all three: newer opsets introduce ops it doesn't
support, dynamic batches confuse layout inference, and FP16 weights
inside the ONNX collide with its INT8 calibration step.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["hailo", "gpu"], default="hailo",
                    help="Which deployment path to optimise the export for. "
                         "'hailo' → yolo11l backbone, NMS stripped, opset 11 — "
                         "feeds tools/compile-hef/. "
                         "'gpu' → yolo26l backbone, NMS-free head retained, "
                         "loaded directly by the pipeline's nvinfer PGIE.")
    ap.add_argument("--data", default="dataset/dataset.yaml",
                    help="path to Ultralytics dataset YAML (default: dataset/dataset.yaml — what pull-dataset.sh fetches)")
    ap.add_argument("--variant", default=None,
                    help="pretrained backbone (yolo{11,26}{n,s,m,l,x}.pt). "
                         "Defaults to yolo11l.pt for --target hailo or "
                         "yolo26l.pt for --target gpu.")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640,
                    help="model input shape. 640 matches both the Hailo HEF "
                         "and the DeepStream PGIE network-input-shape today; "
                         "don't change unless you're also retuning the deploy side.")
    ap.add_argument("--batch", type=int, default=16,
                    help="per-GPU batch; on DGX Spark 128 GB unified mem you can crank this to 32+ on yolov11l")
    ap.add_argument("--patience", type=int, default=20,
                    help="early-stop patience: # epochs without val mAP improvement before stopping")
    ap.add_argument("--name", default=None,
                    help="run name under runs/; default auto-increments fnvr-v{N}")
    ap.add_argument("--device", default="0",
                    help="CUDA device id, comma-separated for multi-GPU, or 'cpu'")
    args = ap.parse_args()

    if args.variant is None:
        args.variant = "yolo11l.pt" if args.target == "hailo" else "yolo26l.pt"

    # Auto-name fnvr-v1, fnvr-v2, ... so consecutive runs don't
    # clobber each other and the HEF compile step picks the right
    # ONNX by version.
    name = args.name or _next_run_name(Path("runs"))
    print(f"=== fnvr train-detector === run name: {name}")

    model = YOLO(args.variant)
    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=args.patience,
        device=args.device,
        project="runs",
        name=name,
        # Saving best + last is the default; we don't need to keep
        # every-epoch checkpoints (eats DGX storage fast on long
        # runs).
        save_period=-1,
        # Letterbox augmentation matches what DeepStream's nvinfer
        # PGIE feeds the model in production — without it the
        # trained model gets cropped predictions in the deployed
        # pipeline.
        rect=False,
    )

    # Export the best checkpoint. Shape depends on target:
    #   - hailo: opset 11, simplified, no NMS — Hailo's compiler
    #     re-attaches NMS as a post-process layer.
    #   - gpu:   keep the NMS-free yolo26 head intact. DeepStream-Yolo's
    #     custom parser (NvDsInferParseYolo) expects exactly this
    #     shape; trying to strip changes the output channel count and
    #     the parser bails out.
    best_pt = Path("runs") / name / "weights" / "best.pt"
    print(f"=== exporting {best_pt} for target={args.target} ===")
    onnx_model = YOLO(str(best_pt))
    if args.target == "hailo":
        onnx_path = onnx_model.export(
            format="onnx",
            imgsz=args.imgsz,
            opset=11,
            simplify=True,
            dynamic=False,
            half=False,
            nms=False,
        )
        print(f"=== ONNX written to {onnx_path} ===")
        print("Next: run tools/compile-hef/ on an x86 box with hailomz to produce the HEF.")
    else:  # gpu
        onnx_path = onnx_model.export(
            format="onnx",
            imgsz=args.imgsz,
            # opset 17 is what Ultralytics' export_yolo26.py uses in
            # the pipeline image's build step, so we stay consistent
            # with the engine builder DeepStream-Yolo expects.
            opset=17,
            simplify=True,
            dynamic=False,
            half=False,
        )
        print(f"=== ONNX written to {onnx_path} ===")
        print(f"Next: rsync this ONNX to the Orin's fnvr-data volume:")
        print(f"  rsync -avz {onnx_path} \\")
        print(f"      tim@172.16.4.23:/var/lib/docker/volumes/fnvr-data/_data/models/yolo26/{name}.onnx")
        print(f"Then on the Orin: set detector.yolo26_variant to '{name}' in the API,")
        print(f"and restart the pipeline. nvinfer rebuilds the FP16 TRT engine on")
        print(f"first inference (~2 min); subsequent restarts use the cached engine.")


def _next_run_name(runs_dir: Path) -> str:
    """fnvr-v1, fnvr-v2, ... — picks the smallest unused N."""
    runs_dir.mkdir(parents=True, exist_ok=True)
    used = set()
    for child in runs_dir.iterdir():
        if not child.is_dir():
            continue
        name = child.name
        if name.startswith("fnvr-v") and name[6:].isdigit():
            used.add(int(name[6:]))
    n = 1
    while n in used:
        n += 1
    return f"fnvr-v{n}"


if __name__ == "__main__":
    main()
