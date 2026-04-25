"""
Trim a YOLO detection head to a subset of COCO classes — no
fine-tuning, just tensor slicing. Keeps the already-trained
weights for the kept classes, drops the rest, and saves the
trimmed checkpoint. Export to ONNX is delegated to
DeepStream-Yolo's `export_yolo26.py` so the output shape
matches what the production pipeline's nvinfer parser expects.

Why bother: yolo26's detection head emits per-class channels at
3 scales. With 80 COCO classes the head is much larger than the
~15 classes you actually care about. Trimming gives you:
  - smaller model + smaller TensorRT engine
  - faster inference (smaller head conv on the GPU)
  - no accuracy loss on kept classes (those weights are unchanged)

How it works:

  yolo11/yolo26 detection heads have classification convs that
  output `nc` channels per scale. yolo26's NMS-free head also
  has `one2one_cv3` (the deployed branch). We slice dim 0 of
  every nc-output Conv2d to keep only the class-id positions in
  --keep, in their original order. The rest of the network is
  untouched.

Usage (inside the fnvr-train-detector container):
  python trim-classes.py \\
      --source yolo26l.pt \\
      --keep 0 1 2 3 4 5 6 7 8 15 16 17 18 19 21 \\
      --names person bicycle car motorcycle airplane bus train truck boat cat dog horse sheep cow bear \\
      --out fnvr-yolo26l-v1
  → produces:
      runs/fnvr-yolo26l-v1/weights/best.pt   (trimmed checkpoint)
      runs/fnvr-yolo26l-v1/weights/best.onnx (ready to deploy via fnvr-data volume)
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import torch
from ultralytics import YOLO


def trim_detect_head(model: torch.nn.Module, keep: list[int]) -> int:
    """Walk every Detect-style head module and slice its
    classification conv weights along the output-channel axis to
    keep only `keep` indices. Mutates in place. Returns the count
    of conv layers that got trimmed (3 per head × N heads, so
    typically 3 for yolo11l and 6 for yolo26l which has both
    `cv3` and `one2one_cv3`).

    Heuristic for "is this a class-output Conv2d": Conv2d whose
    out_channels == old_nc (80 for COCO). This catches all the
    final convs in cv3 / one2one_cv3 / yolov10's v10Detect head
    without us hard-coding the module path.
    """
    keep_idx = torch.tensor(keep, dtype=torch.long)
    nc_new = len(keep)
    nc_old = None

    # First pass: find the model's class count. Look at any
    # Detect-like module's `nc` attribute.
    for m in model.modules():
        if hasattr(m, "nc") and hasattr(m, "stride"):
            nc_old = int(m.nc)
            break
    if nc_old is None:
        raise RuntimeError("could not find nc on any Detect module")
    if nc_old != 80:
        print(f"WARN: source has nc={nc_old} (expected 80 for stock COCO)")

    # Second pass: every Conv2d whose out_channels == nc_old is
    # a per-class output. Slice them all.
    n_trimmed = 0
    for m in model.modules():
        if isinstance(m, torch.nn.Conv2d) and m.out_channels == nc_old:
            with torch.no_grad():
                m.weight = torch.nn.Parameter(
                    m.weight.data.index_select(0, keep_idx).clone()
                )
                if m.bias is not None:
                    m.bias = torch.nn.Parameter(
                        m.bias.data.index_select(0, keep_idx).clone()
                    )
                m.out_channels = nc_new
            n_trimmed += 1

    if n_trimmed == 0:
        raise RuntimeError(
            f"no class-output Conv2d found (looking for out_channels={nc_old})"
        )

    # Third pass: update every Detect-style module's nc + names.
    for m in model.modules():
        if hasattr(m, "nc") and hasattr(m, "stride"):
            m.nc = nc_new
            # `no` is anchor-free output dim; recomputed on
            # forward in modern Detect, but harmless to refresh.
            if hasattr(m, "no"):
                m.no = nc_new + (4 * getattr(m, "reg_max", 16) if hasattr(m, "reg_max") else 4)

    print(f"trimmed {n_trimmed} class-output Conv2d layers from nc={nc_old} to nc={nc_new}")
    return n_trimmed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["gpu", "hailo"], default="gpu",
                    help="Deployment target. 'gpu' → yolo26 family, "
                         "exports through DeepStream-Yolo's export_yolo26.py "
                         "(NMS-free head). 'hailo' → yolo11l, vanilla "
                         "Ultralytics ONNX export (opset 11, NMS stripped). "
                         "Drives both default --source and the export shape.")
    ap.add_argument("--source", default=None,
                    help="pretrained .pt to trim. Defaults: yolo26l.pt for "
                         "--target gpu, yolo11l.pt for --target hailo. yolo26 "
                         "weights download from "
                         "https://huggingface.co/Ultralytics/YOLO26 ; "
                         "yolo11 from Ultralytics' default hub.")
    ap.add_argument("--keep", type=int, nargs="+", required=True,
                    help="space-separated original COCO class IDs to keep, "
                         "in the order you want them in the output model "
                         "(0=person, 2=car, 16=dog, …)")
    ap.add_argument("--names", type=str, nargs="+", required=True,
                    help="display names matching --keep, same order")
    ap.add_argument("--out", required=True,
                    help="run name; output lands at runs/<out>/weights/")
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()

    if len(args.keep) != len(args.names):
        ap.error(f"--keep ({len(args.keep)}) and --names ({len(args.names)}) must have the same length")

    if args.source is None:
        args.source = "yolo26l.pt" if args.target == "gpu" else "yolo11l.pt"

    # If the .pt isn't local, fetch it. yolo26 weights live on
    # HuggingFace (Ultralytics doesn't auto-resolve them); yolo11
    # downloads via Ultralytics' default hub on first YOLO() call.
    src = Path(args.source)
    if not src.exists() and src.name.startswith("yolo26"):
        url = f"https://huggingface.co/Ultralytics/YOLO26/resolve/main/{src.name}"
        print(f"=== fetching {src.name} from HuggingFace ===")
        subprocess.run(["wget", "-q", url, "-O", str(src)], check=True)

    print(f"=== loading {args.source} ===")
    yolo = YOLO(str(args.source))
    nn_model = yolo.model

    print(f"=== trimming head to {len(args.keep)} classes: {args.names} ===")
    trim_detect_head(nn_model, args.keep)

    # Update top-level Ultralytics state so downstream save sees
    # the new class metadata. `yolo.names` is a property without a
    # setter in 8.3.55+; the underlying model.names is mutable.
    new_names = {i: n for i, n in enumerate(args.names)}
    if hasattr(yolo.model, "names"):
        yolo.model.names = new_names
    if hasattr(yolo.model, "yaml") and isinstance(yolo.model.yaml, dict):
        yolo.model.yaml["nc"] = len(args.keep)

    out_dir = Path("runs") / args.out / "weights"
    out_dir.mkdir(parents=True, exist_ok=True)
    pt_path = out_dir / "best.pt"
    print(f"=== saving trimmed checkpoint to {pt_path} ===")
    # Format must match what Ultralytics' YOLO() loader expects:
    # a dict with at least a `model` key.
    yolo.ckpt = {
        "model": yolo.model,
        "ema": None,
        "updates": 0,
        "optimizer": None,
        "train_args": {},
        "train_metrics": {},
        "epoch": -1,
        "best_fitness": None,
        "date": "trim-classes",
        "version": "8.3",
    }
    torch.save(yolo.ckpt, pt_path)

    onnx_path = out_dir / "best.onnx"
    if args.target == "gpu":
        # Export via DeepStream-Yolo's export_yolo26.py — that's what
        # the production pipeline uses, so the resulting ONNX is
        # byte-shape-compatible with NvDsInferParseYolo.
        print("=== exporting via export_yolo26.py (DeepStream-Yolo path) ===")
        rc = subprocess.run(
            ["python3", "/usr/local/bin/export_yolo26.py",
             "-w", str(pt_path.resolve()),
             "-s", str(args.imgsz),
             "--simplify"],
            cwd=out_dir,
            check=False,
        ).returncode
        if rc != 0:
            sys.exit(f"export_yolo26.py failed with rc={rc}")
    else:  # hailo
        # Vanilla Ultralytics export. opset 11 + no NMS + static
        # batch + FP32 weights = the shape Hailo's compiler accepts.
        # Different ONNX shape from the gpu path; this is what
        # tools/compile-hef/ feeds to hailomz.
        print("=== exporting vanilla Ultralytics ONNX (Hailo target) ===")
        trimmed = YOLO(str(pt_path))
        out = trimmed.export(
            format="onnx",
            imgsz=args.imgsz,
            opset=11,
            simplify=True,
            dynamic=False,
            half=False,
            nms=False,
        )
        # Ultralytics drops the file in the .pt's directory; move
        # to the canonical name.
        if Path(out) != onnx_path:
            shutil.move(str(out), str(onnx_path))
    if not onnx_path.exists():
        sys.exit(f"export finished but {onnx_path} is missing")
    print(f"=== ONNX written to {onnx_path} ===")

    # Drop a labels.txt next to the ONNX with the kept names in
    # the order the model emits them. The pipeline's nvinfer
    # config points at /var/lib/fnvr/models/yolo26/labels.txt
    # which the entrypoint already writes from coco.labels — but
    # for fnvr-vN runs we want a per-model labels file, so emit
    # one here for the deploy script to ship alongside.
    labels_path = out_dir / "labels.txt"
    labels_path.write_text("\n".join(args.names) + "\n")
    print(f"=== labels written to {labels_path} ===")

    print()
    print("Next:")
    if args.target == "gpu":
        print(f"  rsync -avz {out_dir}/best.onnx \\")
        print(f"      tim@172.16.4.23:/var/lib/docker/volumes/fnvr_fnvr-data/_data/models/yolo26/{args.out}.onnx")
        print(f"Then in Settings → Object detector pick 'Custom fine-tuned' and set the name to '{args.out}'.")
    else:  # hailo
        print(f"  rsync -avz {out_dir}/best.onnx tim@172.16.4.4:~/fnvr-compile-hef/onnx-src/best.onnx")
        print(f"  # then on hammer (172.16.4.4): ./compile.sh {args.out}")
        print(f"Once the HEF is built, rsync it to the Orin's hailo models dir and set hailo_model_version to '{args.out}'.")


if __name__ == "__main__":
    main()
