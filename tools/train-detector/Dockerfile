# Ultralytics YOLO toolchain for fnvr — supports both head-trim
# (`python trim-classes.py …`, CPU-only, fast) and full fine-tune
# (`python train.py …`, GPU-required).
#
# Trim is a pure-CPU tensor slice — no NVIDIA driver needed.
# Train needs the host's CUDA driver visible via `--gpus all`.
#
# We DON'T use NVIDIA's nvcr.io/nvidia/pytorch base because:
#   1. It pre-bundles cv2 + numpy at versions that conflict with
#      Ultralytics' deps and cause import-time crashes.
#   2. The 24.x line predates GB10 (DGX Spark) support; the
#      container refuses to start on the Spark.
# Plain python:3.11-slim works on any arch (ARM64 on Spark, x86 on
# laptops) for the trim path. For training, install torch with the
# right CUDA wheels to match the host driver.
#
# Build:
#   docker build -t fnvr-train-detector tools/train-detector/
# Run (trim, CPU-only, no --gpus needed):
#   docker run --rm -v $PWD:/work -w /work fnvr-train-detector \
#       python trim-classes.py --source yolo26l.pt --keep ... --names ... --out ...
# Run (train, GPU):
#   docker run --gpus all --rm -v $PWD:/work -w /work fnvr-train-detector \
#       python train.py --target gpu --epochs 100
FROM python:3.11-slim-bookworm

# System deps Ultralytics + cv2 dlopen at runtime, plus cmake which
# some onnx-related sdists need for their native build.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        ffmpeg \
        git \
        libgl1 libglib2.0-0 \
        wget \
    && rm -rf /var/lib/apt/lists/*

# Ultralytics + ONNX exporter. numpy<2 because cv2's wheel at this
# version was built against numpy 1.x; opencv-python-headless avoids
# X libs we don't need. torch+torchvision unpinned beyond a floor —
# pip resolves to current ARM64 wheels (~2.5 / 0.20) on the Spark.
# Drop onnxsim (it's an sdist that needs cmake) — Ultralytics can use
# onnxslim instead via its export(simplify=True) path on 8.3.55+.
RUN pip install --no-cache-dir \
    'numpy<2' \
    'torch==2.5.1' \
    'torchvision==0.20.1' \
    'ultralytics==8.3.55' \
    'opencv-python-headless==4.10.0.84' \
    onnx==1.17.0 onnxslim==0.1.34 onnxscript==0.1.0.dev20240817 \
    onnxruntime==1.19.2

# DeepStream-Yolo's export_yolo26.py is the canonical path for
# producing an ONNX whose shape matches what the production
# pipeline's nvinfer custom parser (NvDsInferParseYolo) expects.
# We vendor a copy (rather than cloning HEAD) so the script's
# version is pinned to one we know works against ultralytics 8.3.55.
# DeepStream-Yolo's HEAD periodically rewrites this script with
# Ultralytics-internal-API changes that break older revs.
COPY export_yolo26.py /usr/local/bin/export_yolo26.py
RUN chmod +x /usr/local/bin/export_yolo26.py

WORKDIR /work
COPY train.py /work/train.py
COPY trim-classes.py /work/trim-classes.py
COPY pull-dataset.sh /work/pull-dataset.sh
RUN chmod +x /work/pull-dataset.sh

# Default to running trim — most common operation.
CMD ["python", "trim-classes.py", "--help"]
