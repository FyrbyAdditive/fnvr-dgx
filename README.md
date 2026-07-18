# fnvr-dgx

An open-source network video recorder with real AI built in, tuned for
the **NVIDIA DGX Spark** (GB10 Grace Blackwell). Point it at your
cameras and it records everything, understands what it sees, and tells
you when something matters — all on your own hardware, with no cloud,
no subscription, and no footage leaving the building.

Forked from [fyrbyAdditive/fnvr](https://github.com/fyrbyAdditive/fnvr)
(which targets the Jetson AGX Orin).

## What it does

- **Watch everything live** — a WebRTC grid of all cameras with
  sub-second latency and detection boxes drawn on the video.
  Bandwidth-friendly proxy streams for the grid, full quality when you
  enlarge a tile.
- **Record everything, keep what fits** — continuous recording with
  per-camera retention and quota, emergency purge before the disk
  fills, and a timeline with recording/event/activity bands that
  scrubs to the exact frame.
- **Recognise objects** — RF-DETR object detection over every stream
  (batched on the GPU via Triton), with per-camera detector selection,
  class mutes, and one-click "not a real detection" flagging that
  suppresses visually-similar false positives.
- **Recognise faces** — SCRFD detection + ArcFace-aligned TopoFR
  embeddings. Enrol from live sightings, clusters of recurring
  strangers, or an uploaded photo; new enrolments retroactively claim
  earlier sightings. Quality gates and diversity pruning keep
  enrolment pools clean; one click erases a person (GDPR-style).
- **Read number plates** — plate detection + OCR with a hotlist and
  historical plate search.
- **Watch your 3D printers** — spaghetti/print-failure detection
  (Obico's community-proven model) on printer-pointed cameras, with
  smoothed scoring so one noisy frame never pages you. Notify-only by
  design.
- **Alert on what matters** — a rules engine with zones, tripwires,
  schedules, cross-camera sequences, cooldowns, and incident
  threading; alarm states (home/away/disarmed) gate rules. Alerts fan
  out to webhooks, ntfy, MQTT, and Home Assistant.
- **Go back in time** — replay historical footage through today's
  detectors (GPU-polite, throttles itself when live load is high).
- **Improve the models** — draw label boxes on live tiles to build
  training datasets from your own footage; weekly drift checks warn
  when face matching degrades.
- **Operate it like software you own** — REST + SSE APIs, Prometheus
  metrics for every pipeline member, self-healing camera workers with
  fault quarantine, and honest docs written from real incidents.

## Documentation

All operator + developer docs live under [docs/](docs/). Start at [docs/README.md](docs/README.md).

Highlights:
- [Install](docs/operations/install.md) — host prep, first boot, adding a camera.
- [Architecture overview](docs/architecture/README.md) — services, data flow, bus subjects.
- [Face-ID](docs/architecture/face-id.md) — the aligned face stack, enrolment, matcher knobs.
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

## License

[AGPL-3.0-or-later](LICENSE). Bundled third-party model weights keep
their own licences (see the model-prep scripts under
[tools/model-prep/](tools/model-prep/) for provenance and pins);
notably the SCRFD face detector and the Obico print-failure model are
non-commercial/AGPL respectively — fine for personal self-hosting.
