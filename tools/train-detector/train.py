"""
Fine-tune a YOLO26 backbone on the fnvr-collected YOLO dataset.

Inputs (mounted into the container at /work):
  - dataset/dataset.yaml + dataset/images/{train,val}/ + dataset/labels/{train,val}/
    These come from the NVR via pull-dataset.sh (same box now — the
    NVR runs on this DGX Spark).

Outputs:
  - runs/fnvr-vN/weights/best.pt
  - runs/fnvr-vN/weights/best.onnx     <- loaded by the pipeline's nvinfer PGIE

(The Orin-era --target hailo export + tools/compile-hef flow was
removed with the Hailo path in fnvr-dgx.)
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from ultralytics import YOLO


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dataset/dataset.yaml",
                    help="path to Ultralytics dataset YAML (default: dataset/dataset.yaml — what pull-dataset.sh fetches)")
    ap.add_argument("--variant", default=None,
                    help="pretrained backbone (yolo26{n,s,m,l,x}.pt). "
                         "Defaults to yolo26l.pt.")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640,
                    help="model input shape. 640 matches the DeepStream PGIE "
                         "network-input-shape today; don't change unless "
                         "you're also retuning the deploy side.")
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
        args.variant = "yolo26l.pt"

    # Auto-name fnvr-v1, fnvr-v2, ... so consecutive runs don't
    # clobber each other and the deploy step picks the right
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

    # Export the best checkpoint with the NMS-free yolo26 head intact.
    # DeepStream-Yolo's custom parser (NvDsInferParseYolo) expects
    # exactly this shape; trying to strip changes the output channel
    # count and the parser bails out.
    best_pt = Path("runs") / name / "weights" / "best.pt"
    print(f"=== exporting {best_pt} ===")
    onnx_model = YOLO(str(best_pt))
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
    print(f"Next: copy this ONNX into the fnvr-data volume on this box:")
    print(f"  sudo cp {onnx_path} \\")
    print(f"      /var/lib/docker/volumes/fnvr-data/_data/models/yolo26/{name}.onnx")
    print(f"Then set detector.yolo26_variant to '{name}' in the API and restart")
    print(f"the pipeline. nvinfer rebuilds the FP16 TRT engine on first")
    print(f"inference; subsequent restarts use the cached engine.")


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
