#!/bin/bash
# Offline INT8 calibration for a YOLO26 variant via trtexec.
#
# Usage: calibrate-yolo26.sh <variant> <output-table-path>
#
# Reads calibration images from:
#   /var/lib/fnvr/models/yolo26/calib_images/
#
# The directory is populated by the api-server's sampler
# (apps/api-server/internal/calibration/sampler.go) which extracts
# representative frames from the operator's own camera recordings.
# If the directory is empty or sparse this script exits non-zero
# and the entrypoint falls back to FP16 — we deliberately do NOT
# fetch a COCO surrogate, because INT8 quantisation tuned to the
# wrong distribution silently degrades inference quality in prod.
#
# Writes calibration table at $2, and a b1/gpu0/int8 engine in the
# model directory as a byproduct of the build.
#
# Exit codes:
#   0   — success (table + engine present)
#   1   — ONNX missing
#   2   — calib_images empty / too few images
#   3   — trtexec not found
#   4   — trtexec failed (engine build error, inspect logs)
#   5   — trtexec succeeded but no calibration table was emitted

set -eu
VARIANT="$1"
OUT_TABLE="$2"

MODEL_DIR=/var/lib/fnvr/models/yolo26
CALIB_DIR="$MODEL_DIR/calib_images"

ONNX="$MODEL_DIR/$VARIANT.onnx"
if [ ! -f "$ONNX" ]; then
    echo "calibrate: missing $ONNX" >&2
    exit 1
fi

if [ ! -d "$CALIB_DIR" ]; then
    echo "calibrate: $CALIB_DIR does not exist — run Prepare calibration images first" >&2
    exit 2
fi
NUM_IMAGES=$(find "$CALIB_DIR" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l)
if [ "$NUM_IMAGES" -lt 100 ]; then
    echo "calibrate: only $NUM_IMAGES images in $CALIB_DIR (need ≥100 — 500 recommended)" >&2
    exit 2
fi
echo "calibrate: building INT8 engine + calib table for $VARIANT using $NUM_IMAGES images"

# trtexec ships with the TensorRT package inside the DeepStream base
# image. Install paths vary across releases; probe both.
if command -v /usr/src/tensorrt/bin/trtexec >/dev/null 2>&1; then
    TRTEXEC=/usr/src/tensorrt/bin/trtexec
elif command -v trtexec >/dev/null 2>&1; then
    TRTEXEC=$(command -v trtexec)
else
    echo "calibrate: trtexec not found; cannot build calibration table" >&2
    exit 3
fi

# Generate the file list trtexec reads via the INT8 calibrator. The
# DeepStream-Yolo INT8 calibrator (built with OPENCV=1) reads
# INT8_CALIB_IMG_PATH to find the image list.
CALIB_LIST="$MODEL_DIR/calibration.txt"
find "$CALIB_DIR" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) \
    > "$CALIB_LIST"
export INT8_CALIB_IMG_PATH="$CALIB_LIST"
export INT8_CALIB_BATCH_SIZE=1

ENGINE_OUT="$MODEL_DIR/${VARIANT}.onnx_b1_gpu0_int8.engine"

# Static input shape (images:1x3x640x640) is required on TRT 10.3
# when the ONNX was exported with a fixed batch. yolo26 from the
# upstream export-yolo26.py is static; --shapes is a no-op but
# harmless and documents intent.
# The ONNX input tensor is named "input" (see export_yolo26.py).
# Because the ONNX is exported with dynamic axes, trtexec needs
# min/opt/max shapes — the calibrator runs under optShapes.
"$TRTEXEC" \
    --onnx="$ONNX" \
    --saveEngine="$ENGINE_OUT" \
    --int8 \
    --fp16 \
    --calib="$OUT_TABLE" \
    --minShapes=input:1x3x640x640 \
    --optShapes=input:1x3x640x640 \
    --maxShapes=input:1x3x640x640 \
    --memPoolSize=workspace:4096 \
    --skipInference \
    || {
        echo "calibrate: trtexec failed. See above for details." >&2
        exit 4
    }

# trtexec may write the calibration cache under a slightly different
# name depending on version; search and rename if needed.
if [ ! -f "$OUT_TABLE" ]; then
    FOUND=$(find "$MODEL_DIR" -maxdepth 1 \
        \( -name "*.cache" -o -name "${VARIANT}*calib*" \) 2>/dev/null | head -1)
    if [ -n "$FOUND" ] && [ "$FOUND" != "$OUT_TABLE" ]; then
        mv "$FOUND" "$OUT_TABLE"
        echo "calibrate: wrote $OUT_TABLE (renamed from $FOUND)"
    else
        echo "calibrate: trtexec succeeded but no calib table produced" >&2
        exit 5
    fi
fi

echo "calibrate: wrote $OUT_TABLE ($(stat -c %s "$OUT_TABLE") bytes)"
echo "calibrate: wrote $ENGINE_OUT ($(stat -c %s "$ENGINE_OUT") bytes)"
exit 0
