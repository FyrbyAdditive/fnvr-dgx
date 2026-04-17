# pipeline-supervisor

C++ / GStreamer / DeepStream process that owns the per-camera video pipeline. Jetson-only at build time (the base image is `nvcr.io/nvidia/deepstream-l4t`).

## Responsibilities (target state)

- Construct one GStreamer pipeline per camera group of 8–16 streams.
- `uridecodebin → nvv4l2decoder → nvstreammux → nvinfer → nvtracker → nvinfer(secondary) → tee → [nvv4l2h265enc → splitmuxsink] + [appsink → NATS] + [webrtcbin]`.
- 30-second pre-event ring buffer, per-camera reconnect with backoff, model hot-swap without pipeline teardown.
- gRPC control surface (add/remove camera, reload model, set recording mode). Registers with `api-server` on startup.
- Publishes detections on NATS (`fnvr.events.detection.<camera_id>`).

## Status: M1 stub

The M1 Dockerfile builds the CMake project as best it can and otherwise idles. The full pipeline lands in M2. Until then, the web UI + API work end-to-end without it — you can exercise camera CRUD, system info, and the layout.

## Building (Jetson)

```bash
cmake -S . -B build
cmake --build build --parallel
```

Needs: JetPack 6.x, DeepStream 7.x, GStreamer 1.20+, CMake 3.22+, protobuf, gRPC.

## Why C++ and not Python bindings

Python bindings exist (`pyds`) but leak under long-running multi-stream loads and impose a GIL around the hot path. For a "large number of cameras" target, the pipeline is C++ from day one.
