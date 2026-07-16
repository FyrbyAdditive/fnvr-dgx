# NVIDIA Model-Optimizer ONNX PTQ container for fnvr.
#
# Bypasses TRT 10.3's broken implicit-precision INT8 calibrator
# (the one that crashes with `checkLinks::218 Internal Error
# Assertion item.second != nullptr` on yolo26 ONNXs) by producing
# a QDQ-annotated ONNX that trtexec loads through the explicit-
# precision path — different code, different bug surface.
#
# Runs on the DGX Spark itself (arm64): base on NGC's multi-arch
# PyTorch container, which carries a CUDA-13/Blackwell-ready torch.
# The old x86_64-only constraint was an Orin-era workaround.
#
# Build:
#   docker build -t fnvr-quant-onnx tools/quant-onnx/
# Run (detached, survives SSH drop):
#   docker run -d --name fnvr-quant-yolo26m \
#       -v "$PWD:/work" \
#       -v "$PWD/onnx-src:/work/onnx-src:ro" \
#       -v "$PWD/dataset:/work/dataset:ro" \
#       fnvr-quant-onnx \
#       /work/quant.sh gpu-yolo26m-v1
# Poll:
#   docker logs -f fnvr-quant-yolo26m
# Output: /work/out/gpu-yolo26m-v1.quant.onnx
# Multi-arch NGC PyTorch base (arm64 slice is Grace/Blackwell-ready).
# Override if the tag ages: --build-arg BASE=nvcr.io/nvidia/pytorch:<yy.mm>-py3
ARG BASE=nvcr.io/nvidia/pytorch:25.08-py3
FROM ${BASE}

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libgl1 libglib2.0-0 \
        wget \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch wheel — modelopt needs torch for its tensor ops
# during calibration but we don't need GPU for PTQ. The CPU wheel is
# ~200 MB vs ~2 GB for CUDA torch; everything in the calibration
# walk fits in CPU memory comfortably for a 25M-param yolo26m.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1 \
        torchvision==0.19.1

# nvidia-modelopt is published as a pure-Python wheel (the heavy bits
# delegate to onnxruntime + numpy + torch). Pin the [onnx] extra to
# pull only the ONNX path, not the LLM / diffusion bits.
#
# onnx + onnxruntime + onnx_graphsurgeon: dependencies for QDQ-node
# insertion and graph rewrites that modelopt does internally.
RUN pip install --no-cache-dir \
        'nvidia-modelopt[onnx]==0.43.0' \
        'numpy<2' \
        'opencv-python-headless==4.10.0.84' \
        Pillow==10.4.0

WORKDIR /work
COPY make-npy.py /work/make-npy.py
COPY quant.sh /work/quant.sh
RUN chmod +x /work/quant.sh

CMD ["/work/quant.sh", "--help"]
