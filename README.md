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

**Status (2026-07-17).** The DGX Spark retarget is live on real
hardware: platform port (DS 9.1 SBSA container, Hailo path removed,
GPU-compute transforms), batched multi-camera mux with strike-based
member resilience and self-healing push relays, model refresh
(**RF-DETR base** primary detector — 3× the headroom of yolo26x with
better recall — AdaFace IR-101 face embeddings, global ANPR),
substream inference (zero main-stream decode), per-member Prometheus
pipeline metrics, and 128 GB-unified-memory Postgres tuning. FP8
quantisation was evaluated and rejected on output parity (fp16
stays; see [tools/benchmark/](tools/benchmark/)). See
[PLAN.md](PLAN.md) for the original milestone list.

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
# clone + start
git clone <repo> fnvr-dgx && cd fnvr-dgx/deploy/docker

# REQUIRED: set FNVR_LAN_IP in .env (comma-separated LAN IPs of this
# host) — MediaMTX advertises these to browsers as WebRTC ICE hosts.
# Never pass it as a shell variable; it would shadow .env and is the
# documented cause of black/flickering live tiles.
$EDITOR .env

docker compose --profile gpu up -d
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
