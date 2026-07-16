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

## DS 9.1 SIGSEGVs when a custom parser returns false

**Status (2026-07-16):** worked around in every parser we ship; needs upstreaming.

If a `NvDsInferParseCustom*` function returns `false`, DS 9.1's error
path ("Failed to parse bboxes") calls `free()` on an invalid pointer
inside `libnvds_infer.so` and the worker dies with SIGSEGV
(gdb-confirmed on GB10). **Parsers must never return false** — on an
unrecognised layout, log once and return `true` with an empty object
list (see `nvdsinfer_plates/`, `nvdsinfer_rfdetr/`).

## nvinfer's output-pool guard false-positives on unified memory

**Status (2026-07-16):** worked around in every nvinfer config; needs upstreaming.

`NvDsInferContextImpl::resizeOutputBufferpool` refuses to grow the
output pool when `cudaMemGetInfo` "free" ≤ `(100 − max-gpu-mem-per)%`
of total. On GB10 unified memory that "free" is **free system RAM**,
which Linux keeps near zero by design (page cache), so the guard trips
spuriously, batches drop ("Dropping the batch as output bufferpool
resize failed") and the error cascade can take the whole group down —
including collateral `GPUassert` inside the (closed-source) NvDCF
tracker that looks like an unrelated bug. Fix shipped: every nvinfer
config sets `max-gpu-mem-per=100` (the check becomes `free ≤ 0`,
never true). Source: `sources/libs/nvdsinfer/nvdsinfer_context_impl.cpp:1455`.

## App-managed pipelines MUST handle LATENCY and CLOCK_LOST

**Status (2026-07-16):** handled in `pipeline.cpp` BusHandler + forced pipeline latency.

`rtspclientsink` completes its RTSP handshake after PLAYING and posts a
LATENCY message; without `gst_bin_recalculate_latency()` the sync'd
push internals pace against a stale latency budget and the MediaMTX
relay trickles at 1–2 fps of mid-GOP frames (browsers then decode only
stray IDRs — "flickering feeds") while inference runs at full rate.
gst-launch recalculates automatically, which is why replicas of the
same graph "worked". Belt-and-braces: the pipeline also forces a flat
500 ms latency (`GstPipeline::latency`) and clamps
`rtspclientsink latency=200`, and a push-leg watchdog self-heals any
member whose relay ratio drops below 60% for 2 minutes.

## WebRTC cannot carry H.265 B-frames

**Status (2026-07-16):** camera-side setting; MediaMTX enforces.

Cameras with "smart" encode modes (H.265+/adaptive B-frames) produce
B-frames under motion. RTP has no DTS, so MediaMTX closes WebRTC
readers with `WebRTC doesn't support H265 streams with B-frames`, and
the recorder logs `DTS is not monotonically increasing`. Fix on the
camera: plain H.265, smart encoding off. Long camera GOPs are also
passthrough-visible: a WebRTC join can take a full GOP to paint
(the web player waits up to 60 s for the first IDR by design).

## Host network sharing: big downloads starve the 4K feeds

**Status (2026-07-16):** operational note.

shodan's uplink is WiFi (`wlP9s9`). Multi-GB downloads on the host
(driver/CUDA updates, image pulls) contend with camera RTSP traffic;
the highest-bitrate (4K H.265) streams hit `Could not read from
resource` first and self-heal when bandwidth returns. Prefer a wired
NIC for camera traffic, or schedule big downloads knowing the 4K
feeds will blip. Similarly, heavy GPU jobs on the box (engine builds,
quantisation) can stall push pacing — the push-leg watchdog now
recovers it automatically.

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
