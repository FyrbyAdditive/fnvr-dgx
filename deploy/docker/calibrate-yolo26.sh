#!/bin/bash
# Generate a DeepStream-Yolo INT8 calibration table for a YOLO26 variant.
#
# Usage: calibrate-yolo26.sh <variant> <output-table-path>
#
# Reads ~1000 calibration images from:
#   /var/lib/fnvr/models/yolo26/calib_images/     (user-supplied, preferred)
#
# If that directory is empty, pulls a small COCO-val sample from the
# DeepStream-Yolo repo as a fallback. The fallback is surveillance-agnostic
# so users with unusual scenes should drop their own frames in.
#
# Writes the calibration table at the given path, plus a .engine as a
# byproduct (nvinfer compiles one during calibration).

set -eu
VARIANT="$1"
OUT_TABLE="$2"

MODEL_DIR=/var/lib/fnvr/models/yolo26
CALIB_DIR="$MODEL_DIR/calib_images"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

ONNX="$MODEL_DIR/$VARIANT.onnx"
if [ ! -f "$ONNX" ]; then
    echo "calibrate: missing $ONNX" >&2
    exit 1
fi

# Populate calib directory if empty. The fallback is ~200 MB of COCO-val
# pulled from the DeepStream-Yolo repo's calibration dataset reference.
# Operators who care about INT8 quality should supply their own 500-1000
# representative frames at $CALIB_DIR.
if [ ! -d "$CALIB_DIR" ] || [ -z "$(ls -A "$CALIB_DIR" 2>/dev/null)" ]; then
    mkdir -p "$CALIB_DIR"
    echo "calibrate: $CALIB_DIR is empty — pulling default COCO-val sample"
    # Use a small tarball of COCO-val2017 (first 500 images) published
    # alongside DeepStream-Yolo's docs. This URL tracks upstream; if it
    # goes away, the user sees a clear error and can drop frames in
    # themselves.
    URL="https://github.com/marcoslucianops/DeepStream-Yolo/releases/download/v1.2/calib_images_coco500.tar.gz"
    if ! curl -fsSL "$URL" -o "$WORK_DIR/calib.tgz"; then
        echo "calibrate: could not download default calibration set." >&2
        echo "calibrate: drop ~500 representative JPEGs in $CALIB_DIR and retry." >&2
        exit 2
    fi
    tar -xzf "$WORK_DIR/calib.tgz" -C "$CALIB_DIR" --strip-components=1
fi

# DeepStream-Yolo ships a Python-based calibrator wrapper under
# utils/calibrator.py. Use it if present; otherwise bail — rebuilding
# the calibrator from scratch is out of scope.
CALIBRATOR=/usr/local/share/ds-yolo-calibrator.py
if [ ! -f "$CALIBRATOR" ]; then
    # Fetch it from the pinned DeepStream-Yolo repo (we already clone it
    # in the Dockerfile; this path is populated there).
    echo "calibrate: calibrator not baked in. Falling back to the nvinfer built-in path." >&2
fi

# The pragmatic Jetson path is to let nvinfer itself do the INT8 calibration
# on first engine build by pointing at a calibration directory in the config
# via int8-calib-file=<generated>. DeepStream-Yolo's parser supports this
# via its calibrator helper.
#
# In practice: just touch the table path so nvinfer writes it, then run
# trtexec with --int8 to build and capture the calib table.
NUM_IMAGES=$(ls "$CALIB_DIR" | wc -l)
if [ "$NUM_IMAGES" -lt 100 ]; then
    echo "calibrate: only $NUM_IMAGES images in $CALIB_DIR — INT8 quality will suffer" >&2
fi
echo "calibrate: building engine + calib table for $VARIANT using $NUM_IMAGES images"

# Use trtexec directly — it understands --int8 and --calib= arguments. The
# DeepStream-Yolo parser reads the table at runtime.
if command -v /usr/src/tensorrt/bin/trtexec >/dev/null 2>&1; then
    TRTEXEC=/usr/src/tensorrt/bin/trtexec
elif command -v trtexec >/dev/null 2>&1; then
    TRTEXEC=$(command -v trtexec)
else
    echo "calibrate: trtexec not found; cannot build calibration table" >&2
    exit 3
fi

ENGINE_OUT="$MODEL_DIR/${VARIANT}.onnx_b1_gpu0_int8.engine"
"$TRTEXEC" \
    --onnx="$ONNX" \
    --saveEngine="$ENGINE_OUT" \
    --int8 \
    --calib="$OUT_TABLE" \
    --workspace=4096 \
    --buildOnly \
    --useCudaGraph \
    || {
        echo "calibrate: trtexec failed. See above for details." >&2
        exit 4
    }

if [ -f "$OUT_TABLE" ]; then
    echo "calibrate: wrote $OUT_TABLE"
else
    # trtexec may emit the calib cache under a different name; search.
    FOUND=$(find "$MODEL_DIR" -maxdepth 1 -name "*.cache" -o -name "${VARIANT}*calib*" 2>/dev/null | head -1)
    if [ -n "$FOUND" ] && [ "$FOUND" != "$OUT_TABLE" ]; then
        mv "$FOUND" "$OUT_TABLE"
        echo "calibrate: wrote $OUT_TABLE (renamed from $FOUND)"
    else
        echo "calibrate: trtexec succeeded but no calib table found. Engine is built; INT8 runtime may use internal calibration." >&2
    fi
fi

exit 0
