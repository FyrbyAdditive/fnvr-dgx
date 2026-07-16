# Running locally

The non-Jetson path. Exercises auth, cameras, rules, timeline, events, notifications. **No AI pipeline** — DeepStream only runs on Jetson.

## Mac / x86 quick start

```bash
git clone <repo> fnvr && cd fnvr
docker compose --profile lite -f deploy/docker/docker-compose.yml up -d
open http://localhost:8080
```

What comes up:

- `postgres`, `nats` — stateful infra.
- `api`, `events`, `storage`, `notifications`, `ml-worker`, `web` — the Go / Python / React services.
- `mosquitto` — MQTT broker for Home Assistant + MQTT channel testing.

What's skipped under `lite`:

- `pipeline` — C++/DeepStream, Jetson-only.
- `mediamtx`, `usb-bridge`, `testsrc` — synthetic RTSP helpers.

Default login `admin / admin`. Change on first use.

## Add a synthetic camera source

For exercising the recording + rules paths without a real camera:

```bash
docker compose --profile lite --profile dev -f deploy/docker/docker-compose.yml up -d
```

This adds:
- `mediamtx` at `rtsp://mediamtx:8554/` on the docker bridge.
- `testsrc` producing `rtsp://mediamtx:8554/test` — continuous synthetic colour-bars + clock.

In the UI, add a camera pointing at `rtsp://mediamtx:8554/test`. With the `lite` profile, the pipeline service is absent so nothing actually records — this is useful for testing the rest of the stack (camera state tracking, rule forms, SSE, etc.) but won't produce detections.

For end-to-end pipeline work you need a real Jetson; see [operations/install.md](../operations/install.md).

## Iterating on Go services

Rebuild one container without restarting the rest:

```bash
docker compose -f deploy/docker/docker-compose.yml build api
docker compose -f deploy/docker/docker-compose.yml up -d api
```

Hot-reload isn't wired up; the services are small and rebuild in ~20 s on a modern Mac.

## Iterating on the web

Vite dev server is not part of compose. For hot-reload:

```bash
cd apps/web
npm install
npm run dev        # default :5173, proxies /api to http://localhost:8081
```

The proxy config is in [apps/web/vite.config.ts](../../apps/web/vite.config.ts). Browser hits `http://localhost:5173`; API calls go to the real api-server container on `:8081`.

## Iterating on the ml-worker

```bash
cd apps/ml-worker
python -m venv .venv && source .venv/bin/activate
pip install -e .
FNVR_DATABASE_URL="postgres://fnvr:fnvr@localhost:5432/fnvr?sslmode=disable" \
FNVR_NATS_URL="nats://localhost:4222" \
python -m uvicorn fnvr_ml.app:app --reload --port 8090
```

Models go under `/tmp/fnvr-models/faceid/` (or wherever `FNVR_MODELS_DIR` points). You need SCRFD + ArcFace ONNX files to exercise `/embed` + `/detect-and-embed`.

## Force a drift run manually

```bash
sudo docker exec fnvr-ml-worker-1 python -c \
  "from fnvr_ml import drift; import json; print(json.dumps(drift.check(), indent=2))"
```

## Inspect NATS traffic

```bash
sudo docker exec fnvr-nats-1 wget -qO- http://localhost:8222/varz | jq .in_msgs
```

`http://localhost:8222/connz` shows every connection by name. Filter for interesting ones: `fnvr-api`, `fnvr-api-camstate`, `fnvr-event-processor`, `fnvr-notification-dispatcher`. Pipeline workers appear as "(no name)" — that's a known detail (nats-c doesn't set a connection name).

## Database access

```bash
sudo docker exec -it fnvr-postgres-1 psql -U fnvr -d fnvr
```

See [migrations.md](migrations.md) for schema evolution; [settings.md](../operations/settings.md) for runtime knobs.

## Which container does what

| Container | Image | Port |
|---|---|---|
| fnvr-postgres | postgres:16 + pgvector | 5432 (internal) |
| fnvr-nats | nats:2 with JetStream | 4222 internal + 8222 monitor |
| fnvr-mosquitto | eclipse-mosquitto | 1883 internal |
| fnvr-api | fnvr-api:latest | 8081 (external) |
| fnvr-web | fnvr-web:latest (nginx) | 8080 (external) |
| fnvr-events | fnvr-events:latest | 9091 internal (/metrics) |
| fnvr-storage | fnvr-storage:latest | — |
| fnvr-notifications | fnvr-notifications:latest | — |
| fnvr-ml-worker | fnvr-ml-worker:latest | 8090 internal |
| fnvr-pipeline | fnvr-pipeline:latest | — (talks to mediamtx via internal RTSP) |
| fnvr-mediamtx | bluenviron/mediamtx | 8554 (rtsp), 8889 (WebRTC/WHEP), 9996 (chunked fMP4 GET) |
| fnvr-usb-bridge | ffmpeg as RTSP publisher | — |
| fnvr-testsrc | gstreamer synthetic source | — |

All containers join the `fnvr_default` docker bridge; inter-service DNS is hostname = service name.
