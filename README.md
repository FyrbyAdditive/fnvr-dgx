# fnvr

Jetson-native, open-source NVR with embedded AI. Built for the NVIDIA Jetson AGX Orin.

> **Status: M2 in progress.** M1 skeleton done; M2 adds Postgres-backed storage,
> the DeepStream pipeline supervisor, NATS-fed detection events with a live
> SSE overlay in the UI, a rules engine, and a storage manager.
> See [PLAN.md](PLAN.md).

## What this is

A web-based network video recorder that:

- Ingests any camera (RTSP, ONVIF, RTMP, SRT, WebRTC, USB/CSI).
- Runs CUDA-accelerated object detection, ANPR, and face identification on many streams at once via DeepStream.
- Records intelligently to a limited disk (tiered retention, per-camera quotas, pre-event buffering).
- Lets you fix its mistakes — label false positives in the UI and the system fine-tunes its own models.
- Exposes everything over REST + WebSocket + gRPC; integrates with Home Assistant, MQTT, Prometheus, and the usual notification channels.

## Quick start — Jetson

```bash
# host prep (once)
sudo mkdir -p /var/lib/fnvr && sudo chown $USER /var/lib/fnvr
sudo nvpmodel -m 0 && sudo jetson_clocks

# M2 pipeline takes a single camera via env; M3 adds gRPC control.
export FNVR_CAMERA_ID=front
export FNVR_CAMERA_URL="rtsp://user:pass@10.0.0.42:554/Streaming/Channels/101"

docker compose -f deploy/docker/docker-compose.yml up -d
open http://<orin-ip>:8080
```

Default login `admin / admin` — change it on first login.

Full runbook: [docs/deployment/m2-smoke-test.md](docs/deployment/m2-smoke-test.md).

## Quick start — Mac / x86 (no AI pipeline)

```bash
docker compose --profile lite -f deploy/docker/docker-compose.yml up -d
open http://localhost:8080
```

Pipeline container is skipped; the rest exercises (auth, cameras, timeline, events SSE).
Add `--profile dev` to bring up a synthetic RTSP source at `rtsp://mediamtx:8554/test`.

## Repo layout

See [PLAN.md §9](PLAN.md#9-repository-layout).

## License

[AGPL-3.0-or-later](LICENSE).
