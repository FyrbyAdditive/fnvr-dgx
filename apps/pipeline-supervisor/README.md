# pipeline-supervisor

C++ / GStreamer / DeepStream process. A parent supervisor forks one worker per enabled camera; each worker owns a full GStreamer pipeline from RTSP ingest to H.264 NVENC record + WHEP live + NATS detection publish.

Covered in detail in [docs/architecture/pipeline.md](../../docs/architecture/pipeline.md). Build notes in [docs/developer/building-pipeline.md](../../docs/developer/building-pipeline.md).

## Build

Jetson only. The fast path is `docker compose build pipeline` from the repo root. Manual:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

Needs JetPack 6.x, DeepStream 7.x, GStreamer 1.20+, CMake 3.22+, protobuf, `nats.c`, libjpeg-turbo.

## Why C++ and not Python bindings

`pyds` Python bindings leak under long-running multi-stream loads and impose a GIL around the hot path. For a "many cameras" target, the pipeline is C++ from day one.
