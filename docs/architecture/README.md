# Architecture overview

fnvr is a split into a video pipeline (C++ / DeepStream on the Jetson), a Go control plane, a Python ml-worker for embedding + clustering jobs, and a React web UI. Postgres holds the durable state; NATS is the bus; JetStream is used as a last-value store for camera health. Detections flow one-way from the pipeline into the rest of the system; control flows the other way through the API + NATS.

```
                         ┌──────────────────────────────┐
  Cameras (RTSP, ONVIF,  │   pipeline-supervisor (C++)  │
  USB via MediaMTX)      │   DeepStream 7 / GStreamer   │
  ──────────────────▶    │   uridecodebin → nvinfer ×N  │
                         │   → nvtracker → tee →        │
                         │     [h264 → fMP4 record]     │
                         │     [WHEP live]              │
                         │     [probe → NATS detection] │
                         └─────┬───────────────┬────────┘
                               │ detections    │ camera-state heartbeat
                               ▼               ▼  (JetStream)
  ┌────────────────┐   ┌────────────────────────────────┐
  │  api-server    │◀─▶│  event-processor (Go)          │
  │  (Go)          │   │  rules engine: zones, tripwires│
  │  REST + SSE +  │   │  cross-camera sequence rules,  │
  │  /metrics +    │   │  face-match (top-K mean),      │
  │  auth + RBAC   │   │  hotlist, drift alerts →       │
  └───┬────────────┘   │  incidents on NATS             │
      │                └────────────────┬───────────────┘
      │                                 │ incidents
      │                                 ▼
      │        ┌────────────────────────────────────────┐
      │        │  notification-dispatcher (Go)          │
      │        │  webhook · ntfy · MQTT · Home Assistant│
      │        └────────────────────────────────────────┘
      │
      ├──▶ storage-manager (Go): segment index, retention,
      │                          per-camera quota, disk-pressure purge.
      └──▶ ml-worker (Python):   face embedding, HDBSCAN clustering,
                                 drift check on enrolment self-similarity.

  Datastores:  Postgres 16 + pgvector
               NATS (core) + JetStream (last-value state)
               Redis (session cache, not load-bearing)
  Storage:     /var/lib/fnvr/recordings/YYYY/MM/DD/HH/<cam>/rec.mp4
               /var/lib/fnvr/models/{yolo26,anpr,faceid}/
               /var/lib/fnvr/thumbs/faces/<detection_id>.jpg
```

## Why this shape

DeepStream is the only realistic way to hit "many cameras" on Orin: `nvstreammux` batching + zero-copy NVMM delivers a 2–4× throughput win over per-stream inference, and NVDEC/NVENC hardware codec paths are native. Everything else is a thin control plane around it.

The pipeline is deliberately stateless from a DB perspective — it only publishes detections + heartbeats on NATS and writes segment files to disk. Every persistent decision (matching a face to a person, firing an incident, purging a segment) happens in one of the Go services so the pipeline container can be rebuilt / restarted without coordinating DB transactions.

## Subsystems

Each has its own deep-dive:

- [Pipeline](pipeline.md) — DeepStream graph, WHEP live view, detection publish, heartbeat.
- [Rules engine](rules-engine.md) — zones, tripwires, cooldowns, cross-camera sequence rules, face match, drift alerts, hotlist.
- [Storage](storage.md) — segment rotation, indexing, retention, quota, disk-pressure purge.
- [Face-ID](face-id.md) — face detector (SCRFD) + embedder (ArcFace) + top-K mean matcher + drift detection.
- [Notifications](notifications.md) — channel types, subscription matching, MQTT/HA bridge.
- [Data model + wire format](data-model.md) — Postgres tables, NATS subjects, Prometheus metrics.

## Services at a glance

| Service | Language | Purpose |
|---|---|---|
| [pipeline-supervisor](../../apps/pipeline-supervisor/) | C++ | Per-camera GStreamer + DeepStream pipeline, records + publishes detections. |
| [api-server](../../apps/api-server/) | Go | REST + SSE + Prometheus, auth, RBAC, settings, erasure, migrations. |
| [event-processor](../../apps/event-processor/) | Go | Consumes detections, runs the rules engine, fires incidents. |
| [storage-manager](../../apps/storage-manager/) | Go | Indexes segments, enforces retention + quota + disk-pressure floor. |
| [notification-dispatcher](../../apps/notification-dispatcher/) | Go | Fans incidents out to configured channels. |
| [ml-worker](../../apps/ml-worker/) | Python | FastAPI sidecar: face detect/embed for uploads, HDBSCAN clustering, drift check. |
| [web](../../apps/web/) | React + Vite | Live, timeline, events, cameras, rules, plates, faces, storage, settings. |

## What's shipped and what isn't

See [PLAN.md](../../PLAN.md) for the full v1 vision. As of 2026-04-21:

- **Done:** live WebRTC view, timeline playback, object detection (YOLO26 via DeepStream), ANPR + hotlist, face detect/embed/match (with top-K mean + margin), unknown-face clustering, drift detection, per-camera retention + quota + disk-pressure floor, webhook / ntfy / MQTT / Home Assistant channels, Prometheus metrics on api-server (8081) and event-processor (9091), cross-camera sequence rules, role-based access + API tokens, GDPR erasure.
- **Deferred (blocked on external resource):** TAO fine-tune (needs a training box, not inference-only Jetson), Telegram / Signal / SIP (no accounts), OIDC / WebAuthn, INT8 YOLO calibration (TRT 10.3 bug — see [known issues](../operations/known-issues.md)).
- **Not yet built:** CLIP semantic search, cross-camera ReID, federation hub, heatmaps/occupancy/dwell-time, evidentiary export bundles. All are PLAN.md M5+ items.
