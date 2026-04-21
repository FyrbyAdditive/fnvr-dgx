# syntax=docker/dockerfile:1.7
#
# fnvr ml-worker sidecar. CPU-only Python 3.11 container serving:
#   - POST /detect-and-embed   (photo-upload enrolment)
#   - POST /cluster            (HDBSCAN on embedding lists)
#   - POST /batch-cluster      (nightly / on-demand unmatched faces)
#   - POST /drift-check        (weekly self-match degradation alert)
#
# Runs on the docker-internal bridge only (no published port). The
# only client is api-server.
#
# Models (face_detector.onnx + arcface.onnx) are bind-mounted from
# the fnvr-data volume; they land there via the pipeline container's
# first-boot seeding so this image doesn't need to ship them.
FROM python:3.11-slim AS build

# hdbscan builds a C extension; opencv-python-headless + onnxruntime
# only need runtime libs. Install build toolchain for the compile
# then discard in the runtime stage.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
        libopenblas0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY apps/ml-worker/pyproject.toml ./
COPY apps/ml-worker/fnvr_ml ./fnvr_ml

# Install into a venv we copy over to the runtime stage.
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir .

# --- runtime stage ---------------------------------------------------
FROM python:3.11-slim

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Runtime deps only — libopenblas + libgomp for onnxruntime + hdbscan,
# libglib/libgl for opencv-python-headless's image codecs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libopenblas0 \
        libgomp1 \
        libglib2.0-0 \
        libgl1 \
        ca-certificates \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/venv /opt/venv
COPY apps/ml-worker/fnvr_ml /opt/fnvr_ml/fnvr_ml
WORKDIR /opt/fnvr_ml

EXPOSE 8090
CMD ["uvicorn", "fnvr_ml.app:app", "--host", "0.0.0.0", "--port", "8090"]
