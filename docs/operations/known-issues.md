# Known issues

Platform quirks and upstream bugs we can't fix ourselves. Each entry has the workaround we ship + the resume path. Target platform: DGX Spark (GB10) on DGX OS.

## DeepStream on DGX Spark is container-only — and the tag matters

**Status (2026-07-16):** handled in `deploy/docker/Dockerfile.pipeline`.

Native DeepStream install on DGX Spark is unsupported; the only supported form is the dedicated container:

```
nvcr.io/nvidia/deepstream:9.1-triton-sbsa-dgx-spark
```

**Trap:** `9.1-triton-multiarch` looks right and pulls fine on the Spark, but its **arm64 slice is the Jetson (L4T) build** — its `libnvbufsurface.so`/`libnvbufsurftransform.so` are dangling symlinks into `/usr/lib/aarch64-linux-gnu/tegra/`, which only exists on a Jetson host. Linking against them fails with `cannot find -lnvbufsurface`; running would be worse.

Related, documented-harmless: the container prints `WARNING: Detected NVIDIA GB10 GPU, which is not yet supported in this version of the container` at startup. Ignore it (per DS 9.1 release notes); never grep container logs for "not supported" in healthchecks.

## The DS base image's apt state lies in two ways

**Status (2026-07-16):** handled in `deploy/docker/Dockerfile.pipeline`; watch for recurrences when adding packages.

1. **NVIDIA's Jetson apt repo is enabled inside the image** (`repo.download.nvidia.com/jetson/common r39.x` in `/etc/apt/sources.list`). Its packages shadow Ubuntu's with higher versions — notably an OpenCV 4.8 `-dev` package whose `/usr/lib` symlinks dangle (runtime libs never land) and whose `opencv4.pc` advertises a `gapi` module Ubuntu doesn't build. The Dockerfile comments the repo out before any `apt-get`; we build OpenCV from source instead (`OPENCV_VERSION` ARG).
2. **Some packages are registered in dpkg but their files are stripped** from the image (e.g. `libjbig0`). A plain `apt-get install` no-ops ("already newest version") and the `.so` never appears. Use `apt-get install --reinstall` and assert the file exists (see the `libjbig0` layer). The Orin-era Dockerfile's "re-install libx264 last" hack was the same pathology.

## VIC does not exist on GB10

**Status:** by design; handled in code.

All `NvBufSurfTransform` work must run as GPU compute. `apps/pipeline-supervisor/src/surface_alloc.cpp` pins a per-thread GPU transform session (own non-blocking CUDA stream) and allocates CPU-readable surfaces as `NVBUF_MEM_CUDA_UNIFIED` (Tegra's `NVBUF_MEM_SURFACE_ARRAY` fails to allocate on SBSA). Any new element that can route to VIC needs `compute-hw=1`.

Also per DS 9.1 docs: only `nv3dsink` works for on-box display (we use `fakesink`; irrelevant unless debugging with a monitor attached).

## Docker on DGX OS: no `nvidia` runtime, additive-only profiles

**Status (2026-07-16):** handled in `deploy/docker/docker-compose.yml`.

- DGX OS ships nvidia-container-toolkit in CDI mode with **no `nvidia` docker runtime registered** — `runtime: nvidia` fails. Use compose device reservations (`driver: nvidia, count: all, capabilities: [gpu]`).
- Compose profiles are **additive-only**. The upstream `profiles: ["!lite"]` negation was never valid and silently excluded the pipeline from `docker compose up`. The pipeline now sits behind an explicit `gpu` profile: `docker compose --profile gpu up -d`.

## Postgres 18 image data layout

**Status (2026-07-16):** handled in compose.

The `pgvector/pgvector:pg18` (postgres 18) image keeps PGDATA in a version subdirectory and refuses the old `/var/lib/postgresql/data` single-mount. Mount the parent: `postgres-data:/var/lib/postgresql`. Existing pg16 volumes need `pg_upgrade`; fresh installs just work.

## YOLO26 INT8 calibration (legacy — superseded by FP8/NVFP4 plan)

**Status (2026-07-16):** unverified on TRT 10.16; low priority.

On the Orin, INT8 calibration crashed inside TRT 10.3 ([TensorRT#3937](https://github.com/NVIDIA/TensorRT/issues/3937)); the entrypoint falls back to FP16 with a red banner. The Spark's TRT 10.16 may have fixed the calibrator, but the Phase-3 model refresh moves quantisation to FP8/NVFP4 via TensorRT Model Optimizer (`tools/quant-onnx`), which makes the INT8 path a dead end either way. The FP16 default is comfortably fast on GB10 (yolo26x engine build ~19 s; SM ~34% for 2×1080p cameras at full frame rate).

**FP16 capacity workarounds** if you need more cameras before the batched-mux + FP8 work lands:

- **`interval=N`** on the primary nvinfer — skip inference on N−1 of every N frames. Tracker smooths the gaps.
- **Lower nvstreammux resolution** — yolo26 runs on the muxed resolution, not source.
- **Per-camera detector whitelist** — `cameras.enabled_detectors` lets you skip face / ANPR per camera.

## Blocked integrations (no workaround required)

These features are intentionally not built because we don't have the external resource to integrate with.

- **Telegram / Signal / SIP channels** — no accounts / no SIP server configured.
- **OIDC / WebAuthn** — local auth only today.
- **Cross-camera ReID / CLIP semantic search / federation hub** — PLAN.md M5 items, not started.

See [architecture/README.md § what's shipped](../architecture/README.md#whats-shipped-and-what-isnt) for the full picture.
