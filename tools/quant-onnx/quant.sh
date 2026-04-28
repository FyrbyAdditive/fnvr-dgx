#!/usr/bin/env bash
# Quantise a trimmed yolo26 ONNX into a QDQ-annotated ONNX via
# NVIDIA Model-Optimizer's onnx_ptq path. Bypasses TRT 10.3's
# broken implicit-precision INT8 calibrator on yolo26 ONNXs.
#
# Layout (mounted at `docker run`):
#   /work/onnx-src/best.onnx        <- trimmed ONNX from yolo-variants/<variant>/
#   /work/dataset/images/train/     <- letterboxed calibration JPEGs
#   /work/out/<variant>.quant.onnx  <- output (QDQ-annotated)
#
# Args: <variant>  (e.g. gpu-yolo26m-v1)
set -euo pipefail

VARIANT="${1:?usage: quant.sh <variant>  (e.g. gpu-yolo26m-v1)}"
ONNX_SRC="/work/onnx-src/best.onnx"
ONNX_DST="/work/out/${VARIANT}.quant.onnx"
CALIB_NPY="/work/calib.npy"

mkdir -p /work/out

echo "=== [1/3] building calibration tensor from $CALIB_NPY ==="
# Look for already-letterboxed JPEGs first (e.g. /work/calib-letterboxed/
# from a prior tools/compile-hef/ run). Fall back to /work/dataset/images/train/
# if a freshly-prepared dir isn't there yet — make-npy will fail loudly if
# those need letterboxing first.
if [ -d /work/calib-letterboxed ] && [ "$(ls -A /work/calib-letterboxed 2>/dev/null)" ]; then
    CALIB_SRC=/work/calib-letterboxed
elif [ -d /work/calib ] && [ "$(ls -A /work/calib 2>/dev/null)" ]; then
    CALIB_SRC=/work/calib
else
    CALIB_SRC=/work/dataset/images/train
fi
echo "calibration source: $CALIB_SRC"

if [ ! -f "$CALIB_NPY" ]; then
    python3 /work/make-npy.py \
        --src "$CALIB_SRC" \
        --dst "$CALIB_NPY" \
        --imgsz 640
else
    echo "calib.npy already present, reusing"
fi

echo "=== [2/3] running modelopt PTQ (INT8 entropy) ==="
# Modelopt's CLI:
#   --onnx_path                source ONNX
#   --output_path              QDQ-annotated ONNX written here
#   --calibration_data         the .npy produced above
#   --quantize_mode int8       what we want
#   --calibration_method entropy  same algorithm trtexec uses, just
#                              applied through ONNX Q/DQ insertion
#                              instead of in-engine calibration
python3 -m modelopt.onnx.quantization \
    --onnx_path="$ONNX_SRC" \
    --output_path="$ONNX_DST" \
    --calibration_data="$CALIB_NPY" \
    --quantize_mode=int8 \
    --calibration_method=entropy

echo "=== [3/3] inspecting result ==="
python3 - <<PY
import onnx
m = onnx.load("$ONNX_DST")
n_nodes = len(m.graph.node)
n_q  = sum(1 for n in m.graph.node if n.op_type == "QuantizeLinear")
n_dq = sum(1 for n in m.graph.node if n.op_type == "DequantizeLinear")
print(f"total nodes: {n_nodes}")
print(f"  Q  nodes: {n_q}")
print(f"  DQ nodes: {n_dq}")
if n_q == 0 or n_dq == 0:
    raise SystemExit("ERROR: no Q/DQ nodes in output — quantisation didn't run")
PY

echo
echo "=== done ==="
echo "QDQ ONNX: $ONNX_DST"
echo
echo "Next: scp to the Orin and trtexec it:"
echo "  scp $ONNX_DST tim@172.16.4.23:/tmp/"
echo "  ssh tim@172.16.4.23 'sudo docker exec fnvr-pipeline-1 trtexec \\"
echo "      --onnx=/tmp/${VARIANT}.quant.onnx \\"
echo "      --saveEngine=/tmp/${VARIANT}.quant.engine \\"
echo "      --fp16 --memPoolSize=workspace:4096'"
