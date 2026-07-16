# fnvr-dgx

Open-source NVR with embedded AI, heavily optimised for the **NVIDIA
DGX Spark** (GB10 Grace Blackwell). Forked from
[fyrbyAdditive/fnvr](https://github.com/fyrbyAdditive/fnvr), which
targets the Jetson AGX Orin.

A web-based network video recorder that:

- Ingests RTSP/ONVIF/USB cameras.
- Runs CUDA-accelerated object detection, ANPR, and face identification on many streams at once via DeepStream 9.1.
- Records to disk with per-camera retention + quota + emergency-purge.
- Lets operators flag mis-identifications and clean up enrolment pools.
- Exposes REST + SSE + Prometheus; integrates with Home Assistant, MQTT, webhooks, ntfy.

**Status.** Upstream M1–M4 complete on Orin. DGX Spark retarget in
progress: Phase 1 (platform port: DS 9.1 SBSA container, Hailo path
removed, GPU-compute transforms) is code-complete pending on-device
verification; Phases 2–4 (batched multi-camera mux, model refresh to
RF-DETR/AdaFace/global-ANPR + FP8, scale-to-16-cameras tuning) are
planned. See [PLAN.md](PLAN.md) for the original milestone list.

## Documentation

All operator + developer docs live under [docs/](docs/). Start at [docs/README.md](docs/README.md).

Highlights:
- [Install](docs/operations/install.md) — host prep, first boot, adding a camera. (Being rewritten for DGX OS.)
- [Architecture overview](docs/architecture/README.md) — services, data flow, bus subjects.
- [Face-ID tuning](docs/operations/face-id.md) — enrolment, matcher knobs, troubleshooting.
- [Troubleshooting](docs/operations/troubleshooting.md) — symptoms → fixes, mined from real incidents.
- [Known issues](docs/operations/known-issues.md) — things we've hit that aren't yet fixable upstream.

## Quick start — DGX Spark

DeepStream on the Spark is container-only; the pipeline image builds
from the DS 9.1 SBSA container (NGC login required for the base pull).

```bash
# on the Spark, once
sudo mkdir -p /var/lib/fnvr && sudo chown $USER /var/lib/fnvr

# clone + start
git clone <repo> fnvr-dgx && cd fnvr-dgx
export FNVR_LAN_IP=<spark-lan-ip>       # advertised to browsers for WebRTC
docker compose -f deploy/docker/docker-compose.yml --profile gpu up -d
```

Open `http://<spark-ip>:8080`. Default login `admin / admin` — change it immediately.

## Quick start — Mac / GPU-less (no pipeline)

Works for exercising the web UI, rules, notifications, and the API. Pipeline container is skipped.

```bash
docker compose --profile lite -f deploy/docker/docker-compose.yml up -d
open http://localhost:8080
```

Add `--profile dev` to bring up a synthetic RTSP source at `rtsp://mediamtx:8554/test`.

## License

[AGPL-3.0-or-later](LICENSE).
