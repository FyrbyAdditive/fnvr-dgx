#!/usr/bin/env bash
# End-to-end compile: ONNX from train-detector → calibration set →
# Hailo HEF for hailo8l.
#
# Expects the following layout under /work (mounted at `docker run`):
#   /work/onnx/fnvr-vN.onnx       <- copy from runs/fnvr-vN/weights/best.onnx
#   /work/dataset/images/train/   <- same dataset tree the trainer used
#   /work/out/                    <- HEF lands here
#
# Usage (from `tools/compile-hef/`):
#   ./build.sh         # builds the docker image
#   mkdir -p out
#   docker run --rm -it \
#       -v "$PWD:/work" \
#       -v "/path/to/runs/fnvr-v1/weights:/work/onnx-src:ro" \
#       -v "/path/to/dataset:/work/dataset:ro" \
#       fnvr-compile-hef \
#       /work/compile.sh fnvr-v1
#
# The version arg is the ONNX basename without extension; HEF lands at
# /work/out/fnvr-v1.hef.
set -euo pipefail

VERSION="${1:?usage: compile.sh <version> [model_name]  (e.g. compile.sh fnvr-yolo11l-v1 yolov11l)}"
# Model name in hailomz's catalogue — picks which bundled recipe
# (.alls + NMS json) to use. The recipe's hardcoded conv numbering
# must match the source ONNX's backbone size, so for a trimmed
# yolov11m ONNX you must pass `yolov11m` as the model name even if
# your VERSION says fnvr-yolo11m-v1. Default = yolov11l for back-compat
# with existing scripts.
MODEL_NAME="${2:-yolov11l}"
ONNX_SRC="/work/onnx-src/best.onnx"
ONNX_DST="/work/onnx/${VERSION}.onnx"
CALIB_DIR="/work/calib"
OUT_DIR="/work/out"

mkdir -p "$(dirname "$ONNX_DST")" "$CALIB_DIR" "$OUT_DIR"

# 1. Copy the ONNX into a stable name. The Hailo compiler reads it
#    by path; renaming makes the later HEF naming consistent.
echo "=== [1/3] staging ONNX ==="
cp "$ONNX_SRC" "$ONNX_DST"

# 2. Build the calibration image set if missing. 1024 images is the
#    sweet spot — more doesn't measurably improve INT8 accuracy on
#    yolov11l and roughly doubles compile time.
if [ -z "$(ls -A "$CALIB_DIR" 2>/dev/null)" ]; then
    echo "=== [2/3] generating calibration set ==="
    python /work/make-calib.py \
        --src /work/dataset/images/train \
        --dst "$CALIB_DIR" \
        --n 1024 \
        --imgsz 640
else
    echo "=== [2/3] reusing existing $CALIB_DIR ==="
fi

# 3. Hailo Model Zoo compile. yolov11l's recipe (`.alls`, post-process
#    JSON) is bundled in the hailomz container; --ckpt swaps in our
#    fine-tuned ONNX. --classes lets the recipe size the NMS layer to
#    match our trimmed class head — Hailo's compiler reads the actual
#    output channel count from the ONNX, so this is mostly informative
#    but the .alls config templating uses it.
echo "=== [3/3] hailomz compile (this takes ~10-20 min) ==="

# Read the trained class count from the ONNX so the user doesn't have
# to. yolov11's classification output is `[1, 4 + num_classes, anchors]`
# at the 8400-anchor scale.
NUM_CLASSES=$(python -c "
import onnx
m = onnx.load('$ONNX_DST')
# Output 0 (typically 'output0') has shape [N, 4+C, anchors] for
# yolov11. C is num_classes.
out = m.graph.output[0]
shape = [d.dim_value for d in out.type.tensor_type.shape.dim]
print(shape[1] - 4)
")
echo "detected class count from ONNX: $NUM_CLASSES"

# Patch the bundled NMS json (per-variant) to match our trimmed
# class count. The bundled .alls references this file via
# nms_postprocess(...); the only thing that's stock-incompatible
# with our trimmed graph is the class count.
python3 - <<PY
import json
p = "/opt/hailo/hailo_model_zoo/hailo_model_zoo/cfg/postprocess_config/${MODEL_NAME}_nms_config.json"
with open(p) as f:
    cfg = json.load(f)
cfg["classes"] = ${NUM_CLASSES}
with open(p, "w") as f:
    json.dump(cfg, f, indent=2)
print(f"patched {p}: classes={cfg['classes']}")
PY

# Some DFC subsystems read os.environ["USER"] without a fallback.
# Docker containers don't set this by default → KeyError at compile
# time. Set a benign default.
export USER="${USER:-fnvr}"

cd "$OUT_DIR"
# If we already have an optimised HAR from a prior run that died at
# the compile step, resume from it and skip the 60+ min INT8 fine-
# tune. The HAR contains the quantised graph; only the final compile
# pass is left.
HAR_PATH="$OUT_DIR/${MODEL_NAME}.har"
if [ -f "$HAR_PATH" ]; then
    echo "=== resuming from existing HAR ($HAR_PATH) (skipping calibration) ==="
    hailomz compile "$MODEL_NAME" \
        --har "$HAR_PATH" \
        --hw-arch hailo8l \
        --classes "$NUM_CLASSES"
else
    hailomz compile "$MODEL_NAME" \
        --ckpt "$ONNX_DST" \
        --hw-arch hailo8l \
        --calib-path "$CALIB_DIR" \
        --classes "$NUM_CLASSES"
fi

# Rename the compiler's default output to our versioned name.
if [ -f "${MODEL_NAME}.hef" ]; then
    mv "${MODEL_NAME}.hef" "${VERSION}.hef"
fi

echo
echo "=== done ==="
echo "HEF: $OUT_DIR/${VERSION}.hef"
echo "rsync to the Orin:"
echo "  rsync -avz $OUT_DIR/${VERSION}.hef tim@172.16.4.23:/var/lib/docker/volumes/fnvr-data/_data/models/hailo/"
echo "Then flip detector.hailo_model_version on the Settings page (or via API) and the broker reloads."
