# Hailo Model Zoo + Dataflow Compiler container for fnvr.
#
# linux/amd64 ONLY — Hailo's compiler isn't ported to ARM. Run on
# the x86 box at tim@172.16.4.4 (or any other linux/amd64 + Docker
# host). The HEF artefact is architecture-agnostic; rsync it back
# to the Orin afterwards.
#
# We build this image without the gated `hailo_ai/hailomz` base
# (which requires a Hailo developer-zone Docker login). Instead the
# user provides the closed-source Dataflow Compiler wheel as a
# build-context file, and we install hailo_model_zoo from public
# GitHub on top.
#
# Required build context:
#   ./hailo_dataflow_compiler-3.33.1-py3-none-linux_x86_64.whl
#     Get from https://hailo.ai/developer-zone/software-downloads/
#     (free signup) and drop it next to this Dockerfile before
#     building.
#
# Versions:
#   - DFC 3.33.1 ships with Hailo Suite 2025.04
#   - hailo_model_zoo v2.18.0 is the matching ZOO release; provides
#     yolov11l's `.alls` + post-process JSON
#   - On the Orin, hailort 4.23 (broker) runs HEFs the 3.33 compiler
#     emits without issue (Hailo guarantees forward compat for HEF
#     schema across one major rev)

FROM python:3.10-slim-bookworm

# System deps the compiler's native bits dlopen at runtime, plus
# graphviz (required by hailo_model_zoo for emitting graph dumps),
# git for cloning the model zoo, and build-essentials so any
# Python pkgs needing C extensions can compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        graphviz graphviz-dev \
        libgl1 libglib2.0-0 \
        libgomp1 \
        pkg-config \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hailo

# Install the Dataflow Compiler wheel bundled in the build context.
# We use 3.32.0 (paired with model_zoo v2.16) rather than 3.33.1 —
# the 3.33.x parser has a multi-line script bug (newline consumed
# as whitespace defeats the next command's LineStart() match) that
# the model_zoo's bundled .alls files trigger. 3.32.x doesn't have
# this bug. The HEF format is stable across DFC 3.x patch revs, so
# the resulting .hef runs fine with the Orin's hailort 4.23 broker.
COPY hailo_dataflow_compiler-3.32.0-py3-none-linux_x86_64.whl /tmp/
RUN pip install --no-cache-dir /tmp/hailo_dataflow_compiler-3.32.0-py3-none-linux_x86_64.whl \
    && rm /tmp/hailo_dataflow_compiler-3.32.0-py3-none-linux_x86_64.whl

# hailo_model_zoo eagerly imports torch in its infer-factory plugin
# discovery, even though `compile` doesn't need GPU inference. Install
# the CPU-only torch wheel so that import succeeds; we never run
# inference here (HEFs run on the Hailo-8 device after deploy).
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1 \
        torchvision==0.19.1

# hailo_model_zoo from GitHub — the DFC-matching tag. Provides the
# `hailomz` CLI that orchestrates parse → optimise → compile and
# carries per-arch recipes (yolov11l/.alls + JSON post-process).
# Version pairing comes from each tag's setup.py CUR_DFC_VERSION:
#   v2.16 → DFC 3.32.0   (we use this)
#   v2.17 → DFC 3.33.0
#   v2.18 → DFC 3.33.1   (parser bug)
ARG HAILOMZ_TAG=v2.16
RUN git clone --depth 1 --branch ${HAILOMZ_TAG} \
        https://github.com/hailo-ai/hailo_model_zoo.git \
    && cd hailo_model_zoo \
    && pip install --no-cache-dir -e .

# Pillow for the direct compile path's calibration array builder.
RUN pip install --no-cache-dir 'Pillow>=10,<12'

WORKDIR /work
COPY make-calib.py /work/make-calib.py
COPY compile.sh /work/compile.sh
COPY compile-direct.py /work/compile-direct.py
RUN chmod +x /work/compile.sh

CMD ["/work/compile.sh"]
