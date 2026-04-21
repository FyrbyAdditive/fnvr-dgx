# fnvr

Jetson-native, open-source NVR with embedded AI. Built for the NVIDIA Jetson AGX Orin.

A web-based network video recorder that:

- Ingests RTSP/ONVIF/USB cameras.
- Runs CUDA-accelerated object detection, ANPR, and face identification on many streams at once via DeepStream 7.
- Records to disk with per-camera retention + quota + emergency-purge.
- Lets operators flag mis-identifications and clean up enrolment pools.
- Exposes REST + SSE + Prometheus; integrates with Home Assistant, MQTT, webhooks, ntfy.

**Status.** M1–M4 complete. M3 gap-closure (cross-camera sequence rules, Prometheus `/metrics`) shipped. M5 (federation, semantic search, ReID) deferred. See [PLAN.md](PLAN.md) for the full milestone list.

## Documentation

All operator + developer docs live under [docs/](docs/). Start at [docs/README.md](docs/README.md).

Highlights:
- [Install on Jetson](docs/operations/install.md) — host prep, first boot, adding a camera.
- [Architecture overview](docs/architecture/README.md) — services, data flow, bus subjects.
- [Face-ID tuning](docs/operations/face-id.md) — enrolment, matcher knobs, troubleshooting.
- [Troubleshooting](docs/operations/troubleshooting.md) — symptoms → fixes, mined from real incidents.
- [Known issues](docs/operations/known-issues.md) — things we've hit that aren't yet fixable upstream.

## Quick start — Jetson AGX Orin

Full runbook: [docs/operations/install.md](docs/operations/install.md). The short version:

```bash
# on the Orin, once
sudo mkdir -p /var/lib/fnvr && sudo chown $USER /var/lib/fnvr
sudo nvpmodel -m 0 && sudo jetson_clocks

# clone + start
git clone <repo> fnvr && cd fnvr
docker compose -f deploy/docker/docker-compose.yml up -d
```

Open `http://<orin-ip>:8080`. Default login `admin / admin` — change it immediately.

## Quick start — Mac / x86 (no pipeline)

Works for exercising the web UI, rules, notifications, and the API. Pipeline container is skipped.

```bash
docker compose --profile lite -f deploy/docker/docker-compose.yml up -d
open http://localhost:8080
```

Add `--profile dev` to bring up a synthetic RTSP source at `rtsp://mediamtx:8554/test`.

## License

[AGPL-3.0-or-later](LICENSE).
