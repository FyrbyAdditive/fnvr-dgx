#!/bin/bash
# Triton inference service for fnvr (detector.inference_backend=triton).
# Runs from the pipeline image: preps a model repository from the TRT
# engines already on the fnvr-data volume (built by the nvinfer path /
# entrypoint), then serves them. One engine copy + one CUDA context
# for the whole fleet, gRPC on :8001 (compose-internal).
set -eu

REPO=/var/lib/fnvr/triton-repo
MODELS=/var/lib/fnvr/models
VARIANT="${FNVR_RFDETR_VARIANT:-base}"

mkdir -p "$REPO/rfdetr/1"

ENGINE="$MODELS/rfdetr/rfdetr-${VARIANT}.onnx_b1_gpu0_fp16.engine"
if [ ! -s "$ENGINE" ]; then
    # First boot on a fresh volume: build it (same file nvinfer would
    # produce lazily). ~2-3 min on GB10.
    echo "triton-entry: engine missing — building $ENGINE"
    TRTEXEC=/usr/src/tensorrt/bin/trtexec
    [ -x "$TRTEXEC" ] || TRTEXEC=trtexec
    "$TRTEXEC" --onnx="$MODELS/rfdetr/rfdetr-${VARIANT}.onnx" \
        --saveEngine="$ENGINE" --fp16 > /tmp/build.log 2>&1 \
        || { tail -5 /tmp/build.log; exit 1; }
fi

# Content-compare so an engine refresh (model upgrade dropped stale
# engines and rebuilt) propagates into the repo; Triton loads at start.
if ! cmp -s "$ENGINE" "$REPO/rfdetr/1/model.plan"; then
    cp -f "$ENGINE" "$REPO/rfdetr/1/model.plan"
    echo "triton-entry: refreshed rfdetr model.plan"
fi
printf 'platform: "tensorrt_plan"\nmax_batch_size: 0\n' \
    > "$REPO/rfdetr/config.pbtxt"

exec /opt/tritonserver/bin/tritonserver \
    --model-repository="$REPO" \
    --grpc-port=8001 --http-port=8000 \
    --exit-on-error=false
