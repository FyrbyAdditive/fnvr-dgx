# Building the pipeline

C++ / GStreamer / DeepStream. Jetson-only at build time.

## Toolchain

- JetPack 6.x (Orin) — DeepStream 7.x, TensorRT 10.3, CUDA 12.2, cuDNN 8.9.
- GCC 11+, CMake 3.22+.
- GStreamer 1.20+.
- protobuf-compiler, libgrpc++-dev (only used for the proto lib).
- nats.c development headers (built from source in the Dockerfile, not in apt).
- libjpeg-turbo (separate TU from pipeline.cpp to avoid a pre-processor collision with nvdsinfer.h — see below).

The fast path is `docker compose build pipeline` from the repo root. That image uses `nvcr.io/nvidia/deepstream-l4t:7.x-triton-multiarch` as the base and bakes the right LD_LIBRARY_PATH / libv4l fixups (see [deploy/docker/pipeline-entrypoint.sh](../../deploy/docker/pipeline-entrypoint.sh)).

## Manual build on a Jetson

```bash
cd apps/pipeline-supervisor
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/pipeline-supervisor --help
```

No cross-compile. The binary won't run on x86.

## Directory layout

```
apps/pipeline-supervisor/
├── CMakeLists.txt
├── src/
│   ├── main.cpp                 # parent supervisor or --worker <cam> <url> <mode>
│   ├── pipeline.{cpp,h}         # SingleCameraPipeline: GStreamer graph construction
│   ├── supervisor.{cpp,h}       # parent: launches + restarts workers
│   ├── config.{cpp,h}           # YAML config loader
│   ├── nats_publisher.{cpp,h}   # hardened NATS wrapper — see pipeline.md
│   ├── face_crop_jpeg.{cpp,h}   # GPU crop via NvBufSurfTransform + libjpeg-turbo
│   └── gen/                     # generated from libs/proto (protoc runs in CMake)
```

One-process-per-camera model: the parent (supervisor) fork-execs itself with `--worker <cam> <url> <mode>` for each enabled camera. A worker crash never takes down the parent; the parent watches PIDs and restarts with exponential backoff.

## Why libjpeg-turbo is in its own TU

`nvdsinfer.h` pulls in TensorRT headers that `#define INT32` via an internal typedef that clashes with `libjpeg-turbo`'s `INT32` from `jmorecfg.h`. The include order is irreconcilable — whichever you include first, the other breaks.

Fix: the face-crop path that touches `NvBufSurface` + the TRT-adjacent meta types lives in `face_crop_jpeg.cpp` *without* including the libjpeg-turbo headers. A second TU includes libjpeg-turbo and provides the actual JPEG encode. The two talk via a handful of plain C-style `extern "C"` function declarations. Not pretty; correct.

## Why the `nats-c` wrapper exists

See [architecture/pipeline.md § Why the NATS client is wrapped](../architecture/pipeline.md#why-the-nats-client-is-wrapped). Short version: default reconnect policy gives up silently after 2 min; `natsConnection_Publish` still returns OK but messages are dropped. We wrap with unlimited reconnect + explicit CLOSED-state detection + rate-limited log on rebuild.

## GStreamer graph construction

`pipeline.cpp`'s `BuildPipeline()` constructs the graph via a templated string (the giant one you see in pipeline logs). A few decision points:

- **Codec auto-detect.** `ffprobe` runs once at startup to detect H.264 vs H.265 in the RTSP source. Both paths share the downstream nvstreammux + nvinfer graph; only the initial depay + decoder differ.
- **USB cameras go via mediamtx.** A sidecar `mediamtx` container re-publishes any V4L2 webcam as RTSP on the internal docker network. The pipeline treats it the same as an IP camera.
- **Recording is always H.264.** Regardless of source codec. Lets the browser's `<video>` tag play back fMP4 segments natively.
- **ANPR + face SGIEs are conditional.** If `detector.anpr_enabled` or `detector.face_id_enabled` settings are off, the corresponding nvinfer elements are omitted — the graph shrinks accordingly, saving real GPU cycles.

## Engine compile behaviour

nvinfer elements lazy-build their TRT engines on first use and cache under `/var/lib/fnvr/models/<model>/*.onnx_bNN_gpuM_fp16.engine` (or `int8`). Subsequent starts deserialise in ~2 s.

- **First compile on a fresh JetPack:** 5–30 s per model. yolo26x on Orin AGX: ~30 s; yolo26l: a few minutes on first run (slower than yolo26x, counter-intuitively, because it hits a different TRT optimiser branch).
- **Engine cache is keyed on filename.** A JetPack upgrade *doesn't* invalidate it — but the engine may fail to deserialise on the new JetPack, which will fall through to a rebuild automatically (the entrypoint watches for the "deserialize engine from file failed" log line).
- **Pre-baking** via `trtexec`: see [deploy/docker/calibrate-yolo26.sh](../../deploy/docker/calibrate-yolo26.sh) — called by the entrypoint on INT8 attempts and can be called manually for FP16 pre-bake.

## Testing without cameras

```bash
# Run against the synthetic RTSP testsrc:
docker compose --profile dev up -d testsrc mediamtx
# In the UI, add a camera with url=rtsp://mediamtx:8554/test
```

There is no unit-test harness for the C++ pipeline today. Changes are exercised via `docker compose build pipeline && docker compose up -d pipeline` and smoke-tested through the Live page and `SELECT … FROM detections`.

## Stuff you shouldn't touch without care

- **GLib main-loop threading.** The bus watch runs on the main thread; a watch callback that blocks starves every other pipeline message, including state-change transitions past PAUSED. Keep callbacks short; push work to a thread + return.
- **NvBufSurface refcounts.** The face-crop probe must `NvBufSurfaceMap` + transform + unmap without holding the source refcount across async boundaries or you'll see GPU memory grow without bound. See [face_crop_jpeg.cpp](../../apps/pipeline-supervisor/src/face_crop_jpeg.cpp) for the correct dance.
- **`splitmuxsink` vs `filesink + qtmux`.** We moved from splitmuxsink (broken moov-atom updates on crash) to `qtmux + filesink` with `reserved-moov-update-period` so partial mp4s are playable while still being written. Don't regress.
