# fnvr — Jetson-Native Open-Source NVR with Embedded AI

## Context

`fnvr` is a greenfield, open-source NVR targeting the NVIDIA Jetson AGX Orin 64GB dev kit with a dedicated 2TB disk. The goal is a Frigate-class (but deeper) product: a web-based NVR that ingests "any" camera, runs CUDA-accelerated detection / ANPR / face ID on many streams at once, records intelligently to limited disk, and lets users improve the models by labelling mistakes from their own footage.

Scope decisions captured from the brief:

- **Project intent:** open-source product (community-facing, AGPLv3).
- **v1 scope:** everything on the table — core ingest/record/live, detection + rules, ANPR + face ID, in-app training, federation / Home Assistant / MQTT / semantic search / cross-camera ReID / audio.
- **Backend:** Go for API and control-plane services; C++/GStreamer for the pipeline; Python for ML glue.
- **Frontend:** React + Vite.
- **Deploy:** Docker-only (L4T DeepStream base image, single docker-compose.yml).
- **Name:** `fnvr`.

This is a large plan because the scope is large; it is structured so v1 can be built incrementally along the milestones in §8 without repainting the architecture.

## 1. High-Level Architecture

```
                         ┌──────────────────────────────┐
  Cameras (RTSP/ONVIF/   │   pipeline-supervisor (C++)  │
  RTMP/SRT/ONVIF/WebRTC/ │   - DeepStream / GStreamer   │
  GB28181/MJPEG/USB/CSI) │   - NVDEC → nvstreammux →    │
  ───────────────────▶   │     nvinfer → nvtracker →    │
                         │     NVENC → fMP4 + WebRTC    │
                         │   - One process per 8-16     │
                         │     cameras (blast-radius)   │
                         └────────┬───────────────┬─────┘
                                  │ gRPC          │ NATS events
                                  ▼               ▼
  ┌────────────────┐   ┌────────────────────────────────┐
  │  api-server    │◀─▶│  event-processor (Go)          │
  │  (Go)          │   │  - Rules engine (zones,        │
  │  REST + WS +   │   │    tripwires, schedules,       │
  │  gRPC-Gateway  │   │    cross-camera, cooldowns)    │
  │  RBAC, auth    │   └────────────────┬───────────────┘
  └───┬────────────┘                    │
      │                                 ▼
      │        ┌────────────────────────────────────────┐
      │        │  notification-dispatcher (Go)          │
      │        │  webhook/MQTT/HA/email/push/Telegram/  │
      │        │  Signal/ntfy/SIP/GPIO relay            │
      │        └────────────────────────────────────────┘
      │
      ├──▶ storage-manager (Go): segment lifecycle, tiering, purge, SMART
      ├──▶ ml-worker (Python):   TAO/TRT conversion, training, eval,
      │                          active learning, face embedding index
      └──▶ webrtc-signaling (Go): WHEP/WHIP for live-view

  Datastores:  Postgres 16 + TimescaleDB + pgvector | Redis | NATS JetStream
  Bus:         NATS JetStream  (events, job queue, retries, DLQ)
  Storage:     /var/lib/fnvr/recordings/YYYY/MM/DD/HH/<cam>/<seg>.mp4
               /var/lib/fnvr/models /db /thumbs /datasets
```

**Why this shape.** DeepStream is the only realistic way to hit "large number of cameras" on Orin — `nvstreammux` batching + zero-copy NVMM delivers 2–4× over per-stream inference, and NVDEC/NVENC hw codec paths are exposed natively. Everything else is a thin Go control plane around it.

## 2. Video Pipeline (C++/DeepStream)

**Pipeline shape per camera group (8–16 streams per process):**
```
uridecodebin  → nvv4l2decoder  → nvstreammux (batch N)
              → nvinfer (primary detector, TRT .engine)
              → nvtracker (NvDCF / ByteTrack)
              → nvinfer (secondary: plate-detect / face-detect)
              → nvinfer (tertiary: plate-OCR / face-embed)
              → tee
                ├── nvv4l2h265enc → splitmuxsink (fMP4 segments)
                ├── appsink       → detection events → NATS
                └── webrtcbin     → live view (per-viewer)
```

- Separate substream (low-res) and mainstream (full-res) paths: analysis runs on substream, recording on mainstream.
- **Pre-event ring buffer:** 30s rolling in-RAM buffer via `queue2` + `splitmuxsink` with `max-size-time`; on trigger, segment is flushed to disk with the pre-roll prepended.
- **Per-stream reconnect:** `uridecodebin` wrapped in a supervisor that restarts with exponential backoff + jitter; EOS/error never kills the process.
- **NVDEC / NVENC distribution:** Orin has 2× each; round-robin streams across engines and expose utilisation metrics.
- **DLA offload:** primary detector compiled to both GPU and DLA `.engine`; half the cameras dispatched to DLA to free GPU for face/plate models.
- **Hot-swap models:** `nvinfer` reloads on config-change signal without pipeline teardown. This is *hard*, designed-in from day one — not retrofitted.
- **Clock discipline:** always prefer NTP-synced NVR wall-clock for segment filenames; embed camera-PTS in metadata for forensic correlation.
- **Capacity budget (published DeepStream numbers for AGX Orin 64GB):** target ~40 × 1080p H.265 streams with YOLOv8s FP16 @ 5 fps analysis and 30 fps record. Expose this in the benchmark wizard.

**Failure isolation:** one pipeline-supervisor process per group; parent orchestrator (Go) watches them and restarts on crash. A single bad RTSP source cannot take down the NVR.

## 3. Inference & Model Management

- **v1: direct TensorRT via DeepStream `nvinfer`.** Lowest overhead.
- **v2: Triton (`nvinferserver`)** when ensemble models / hot-swap without pipeline reload / Python backends become necessary.
- **Model zoo (bundled, downloaded on first run, model-cards shipped):**
  - Detection: YOLOv8/v11 (FP16 + INT8), TAO PeopleNet, TrafficCamNet.
  - Tracker: ByteTrack, NvDCF, optional OSNet ReID for cross-camera.
  - ANPR: LPDNet (plate box) + LPRNet (OCR) + country-plate format whitelist.
  - Face: RetinaFace (detect) + ArcFace (embed, 512-d), mask-aware variant.
  - Semantic search: CLIP ViT-B/32 for attribute search ("red car 3pm").
- **Model lifecycle:**
  - Models live in Postgres with version, hash, metrics, source, license, status (active / shadow / archived).
  - TRT engine cache under `/var/lib/fnvr/models/engines/<model>@<jetpack>@<precision>/` — rebuilt on JetPack upgrade.
  - **Shadow mode:** run new model alongside active; compare detections; side-by-side review UI; promote after N days or N reviewed samples.
  - **Confidence threshold per class per camera** (the one-size threshold is wrong everywhere).
- **Active learning loop (ml-worker, Python):**
  - Hard-negative mining: surface low-confidence and user-flagged-FP detections for review.
  - Review UI in the frontend accepts / corrects / deletes labels → versioned dataset (DVC-style pointer files in Postgres, blobs on disk).
  - Nightly fine-tune job via TAO (transfer from checkpoint, not from scratch); evaluates against held-out set; auto-promotes to shadow if gain > threshold.
  - Drift detection: weekly accuracy on golden set; alert if drops.
  - Face enrollment: auto-cluster unidentified embeddings; "this unidentified person appears in 47 clips — label them?"

## 4. Detection Rules Engine (event-processor, Go)

- Polygon zones, directional line-crossings, tripwires with dwell.
- Object attribute filters (class + colour + size + make/model for vehicles).
- Schedules (rule active by time-of-day, day-of-week, sunrise/sunset).
- Combinatorial rules ("person AND no-authorised-face in zone X between 22:00–06:00").
- **Cross-camera rules** ("car at gate + not at driveway within 60s → alert").
- Cooldown / debounce per rule; rate-limited per channel.
- **Incident threading:** related detections grouped into incidents, not raw events — UI + alerts deal in incidents.
- Rules stored as JSON in Postgres, evaluated by a compiled DAG per camera; hot-reload on save.
- Scripting hook (JS sandbox via `goja`) for power users to write custom rules.

## 5. Storage (storage-manager, Go)

**Layout:** `/var/lib/fnvr/recordings/YYYY/MM/DD/HH/<cam-uuid>/seg-<ts>.mp4` + sidecar `.json` index.

- **Fragmented MP4** (CMAF) segments, 4s fragments, 120s segment rotation.
- **Pre-event buffer** (see §2) prepended to event-triggered segments.
- **Recording modes per camera:** continuous, motion-only, event-only, scheduled, hybrid (low-bitrate continuous + high-bitrate on event).
- **Tiering:** hot (last 7 d full res) → warm (keyframe-only, configurable) → cold (events-only + thumbnails) → purge.
- **Per-camera retention** and **per-camera quota** (a noisy camera cannot eat the disk).
- **Protected clips** bypass auto-purge; exported clips get a SHA-256 chain-of-custody manifest and optional AES-GCM encryption.
- **Disk-full policy** configurable: stop-and-alarm vs rotate-oldest; alarm either way.
- **Filesystem guidance (docs):** XFS on the recording volume, `noatime`, tuned commit interval. Separate OS disk from recording disk.
- **Thumbnails** every 10s via NVJPEG (not CPU); motion-energy histogram for the timeline strip.
- **SMART** polled every 15 min; predicted-days-until-full + predicted-failure exposed in UI.
- **Backup:** scheduled rsync / S3 / SFTP for config + Postgres + face DB (not raw video by default).

## 6. Frontend (React + Vite)

- **Live view:** mosaic (1/4/6/9/16/25/custom), WebRTC (via `webrtcbin` + WHEP signaling) for focused streams, HLS-LL fMP4 for background tiles, substream on tiles / mainstream fullscreen. Follow-mode auto-swaps a tile when an event fires.
- **Timeline:** per-camera and multi-cam synced; event pins coloured by class; canvas-rendered (no chart library handles 10k events across 30 days).
- **Search:**
  - Structured: class + attribute + zone + camera + time.
  - Semantic: CLIP embeddings ("person carrying package").
  - Face: drag-in photo, similarity search.
  - Bounding-box-to-find-similar from an existing clip.
- **Map view:** cameras placed on floorplan / geo map; events animate.
- **PTZ:** on-screen joystick + optional hardware gamepad; presets, tours, auto-track.
- **Review UI:** one-click "not a person — learn this" for FPs → feeds active-learning dataset.
- **Health dashboards:** per-camera (FPS, decoder errors, reconnect count) and system (GPU / NVDEC / NVENC util, disk IOPS, temps, power mode).
- **Design system** from day one: Tailwind + shadcn/ui + Radix primitives; dark mode; keyboard shortcuts (j/k/l + arrows + space, like video editors); ARIA; i18n (surveillance sells globally); timezone-correct everywhere.
- **State:** TanStack Query for server state, Zustand for UI state.
- **PWA** for mobile; native push notifications with snapshot preview.

## 7. Cross-Cutting Concerns

**Auth / RBAC.** OIDC (Authentik / Keycloak / Google) + local users + WebAuthn / passkeys + TOTP fallback; API keys for scripting; rate-limited login. Roles (superadmin / admin / operator / viewer / guest) **plus** per-camera and per-feature grants (view live / view history / export / PTZ / manage rules / enrol faces / view face DB). Guest links: time-limited single-clip URLs for sharing with police / insurance.

**Audit log.** Append-only, hash-chained, covers auth, config change, export, face-DB read, rule change, user change. Tamper-evident.

**Privacy.** Privacy masks applied pre-storage (legally meaningful — data never written); scheduled masking; face-blur / plate-blur / audio-mute on export; one-click GDPR right-to-erasure (purges embeddings + redacts historic clips). **Face-rec DISABLED by default** with explicit enable + jurisdiction acknowledgement (BIPA / EU AI Act / UK biometrics code). Model cards per bundled model. Full **onboard-only mode** (no cloud, no telemetry, no phone-home).

**Integrations (first-class):** MQTT, Home Assistant (native), webhook, Prometheus `/metrics`, OpenTelemetry traces, ntfy, Telegram, Signal (via signal-cli), Email, Push (FCM/APNs/Web Push), SIP call, GPIO relay (siren/light), SNMP. NVR also re-streams cameras (proxy) and exposes itself as an ONVIF device so other NVRs/VMSes can consume it.

**Reliability.** systemd `Type=notify` watchdogs; one-camera-group-per-process blast radius; disk / thermal / memory health surfaced; per-stream GPU accounting; UPS support via NUT; config validation with last-known-good rollback; OTA updates with signed artifacts, staged rollout, boot-failure rollback, separate "platform" and "models" update channels.

**Federation (v1 design, lean implementation).** Remote `fnvr` nodes push event summaries + thumbnails to a designated "hub" node; video stays at the edge, pulled on demand. Data model and API support this from day one; full multi-node HA lands post-v1.

## 8. Incremental Milestones

Built roughly in order; each milestone is a useful product state.

1. **M1 — Single-camera skeleton.** Docker compose up → add one RTSP camera → live view (WebRTC) + continuous recording to fMP4 + timeline playback. No AI yet. Postgres + api-server + pipeline-supervisor + web, all wired. Auth (local users + admin role). Basic storage purge.
2. **M2 — Many cameras + motion + basic detection.** Multi-camera mosaic. DeepStream batched `nvinfer` with YOLO. Zones and line-crossing. Event log + webhook alerts. Health dashboards. Pre-event buffering.
3. **M3 — ANPR + rule engine maturity.** Plate-detect → plate-OCR pipeline. Hotlist + historical plate search. Schedules, cooldowns, cross-camera rules, incident threading. MQTT + Home Assistant + ntfy + Telegram + Prometheus. Review-FP UI (labels only; training comes next).
4. **M4 — Face ID + training loop.** Face detect + embed + 1:N search (pgvector). Enrollment UX. Unknown-face clustering. ml-worker: TAO-based fine-tune job on labels from M3, shadow-mode deploy, drift alerts. GDPR erasure flow.
5. **M5 — Advanced analytics + federation.** Cross-camera ReID, semantic search (CLIP), heatmaps, occupancy counting, loitering, dwell-time. Federation hub. Map view. Evidentiary export bundles with SHA-256 chain. Full RBAC granularity + OIDC + WebAuthn.
6. **M6 — Polish / commercial readiness.** Import-from-competitor (Frigate/Blue Iris/Shinobi configs). Setup wizard with hardware benchmark. Signed OTA. Plugin system. Docs + camera-compatibility matrix + community site.

## 9. Repository Layout

Monorepo with a task runner (Taskfile) — enough moving parts that a polyrepo will bleed velocity.

```
/Users/tim/VSCode/fnvr/
  apps/
    pipeline-supervisor/     # C++ / DeepStream / GStreamer
    api-server/              # Go: REST + WS + gRPC-gateway, auth, RBAC
    event-processor/         # Go: rules engine, incidents, cooldowns
    storage-manager/         # Go: segment lifecycle, tiering, purge, SMART
    notification-dispatcher/ # Go: channels (MQTT/HA/email/push/...)
    webrtc-signaling/        # Go: WHEP/WHIP for live-view
    ml-worker/               # Python: TAO, TRT convert, training, active learning
    web/                     # React + Vite + Tailwind + shadcn
  libs/
    proto/                   # shared .proto for gRPC + NATS subjects
    go-common/
    py-common/
    models/                  # model cards, conversion scripts, calibration data
  deploy/
    docker/
      Dockerfile.pipeline    # FROM nvcr.io/nvidia/deepstream-l4t:7.x-triton-multiarch
      Dockerfile.api
      Dockerfile.web
      Dockerfile.ml
      docker-compose.yml
      docker-compose.lite.yml
    config/
      fnvr.sample.yaml
  docs/
    architecture/
    cameras/                 # per-brand setup guides
    api/                     # generated OpenAPI
    deployment/
    compliance/              # DPIA template, model cards, bundled-model licenses
  tests/
    integration/
    e2e/
    load/                    # synthetic RTSP stream stress tests
  tools/
    stream-probe/            # "does this RTSP URL work" with protocol trace
    benchmark/               # first-run capacity wizard
    migrate/                 # DB migrations (goose)
  .github/workflows/         # arm64 CI, signed-release pipeline
  Taskfile.yml
  LICENSE                    # AGPLv3
  README.md
```

## 10. Critical Files (first-cut skeleton for M1)

- [apps/pipeline-supervisor/src/main.cpp](apps/pipeline-supervisor/src/main.cpp) — DeepStream pipeline construction, per-group supervisor, gRPC control surface.
- [apps/pipeline-supervisor/src/pipeline.cpp](apps/pipeline-supervisor/src/pipeline.cpp) — camera add/remove, nvstreammux batching, hot-swap hooks.
- [apps/api-server/cmd/api/main.go](apps/api-server/cmd/api/main.go) — HTTP/WS/gRPC bootstrap, config loading, graceful shutdown.
- [apps/api-server/internal/camera/service.go](apps/api-server/internal/camera/service.go) — camera CRUD + ONVIF discovery + credential vault.
- [apps/api-server/internal/auth/rbac.go](apps/api-server/internal/auth/rbac.go) — roles + per-camera grants + audit log writer.
- [apps/event-processor/internal/rules/engine.go](apps/event-processor/internal/rules/engine.go) — rule DAG, cooldowns, incident threading.
- [apps/storage-manager/internal/lifecycle/segmenter.go](apps/storage-manager/internal/lifecycle/segmenter.go) — segment index, tiering, purge, quota.
- [apps/ml-worker/fnvr_ml/active_learning.py](apps/ml-worker/fnvr_ml/active_learning.py) — hard-negative mining, dataset assembly, TAO job submission.
- [apps/web/src/routes/live/+page.tsx](apps/web/src/routes/live/+page.tsx) — mosaic + WebRTC player.
- [apps/web/src/routes/timeline/+page.tsx](apps/web/src/routes/timeline/+page.tsx) — canvas timeline + event pins + scrub.
- [deploy/docker/docker-compose.yml](deploy/docker/docker-compose.yml) — full stack, device passthrough (`/dev/nvhost-*`, `/dev/nvmap`, `--runtime=nvidia`), volume mounts for recordings / models / db.
- [libs/proto/pipeline.proto](libs/proto/pipeline.proto) — pipeline ↔ api-server control contract.
- [libs/proto/events.proto](libs/proto/events.proto) — detection event schema on NATS.
- [Taskfile.yml](Taskfile.yml) — `task dev`, `task build`, `task test`, `task release`.

## 11. Verification

Per-milestone end-to-end tests, not a big-bang integration at the end.

**M1 smoke:**
- `task dev` brings the stack up.
- Add a test RTSP source (use `tools/stream-probe` to validate it first; use `gst-launch-1.0 videotestsrc ... ! rtspclientsink` for a synthetic source).
- Live view renders in < 1s latency via WebRTC.
- Record for 2 min; `ls /var/lib/fnvr/recordings/...` shows fMP4 segments; timeline playback is frame-accurate.
- Kill the test RTSP source; confirm supervisor reconnect with backoff; confirm no process crash.
- Load-test: 10 synthetic streams, confirm GPU / NVDEC util via `tegrastats` and the health dashboard.

**M2 smoke:**
- YOLO detections appear on the live view with boxes; events land in Postgres; webhook fires.
- Draw a zone in the UI, confirm line-crossing fires exactly once per traversal.
- Pre-event buffer: trigger an event, confirm the saved clip starts ~30s before the trigger.

**M3 smoke:**
- ANPR end-to-end: drive a synthetic plate past, confirm OCR result matches the plate, hotlist hit fires the configured channel.
- MQTT + HA: HA auto-discovers cameras + motion sensors; events show up there.
- Cross-camera rule: synthetic car on cam-A triggers, no cam-B within 60s → alert fires.

**M4 smoke:**
- Enrol a face via the UI from 3 angles; confirm pgvector index populated.
- Play footage of the same person on a different camera; confirm 1:N search returns the right ID above the threshold.
- Label 20 FPs; trigger a fine-tune; confirm shadow-mode metrics surface in the UI; promote; confirm the new `.engine` loads without pipeline teardown.
- GDPR erasure: delete a face, confirm embeddings gone, historic thumbnails redacted.

**M5 smoke:**
- CLIP semantic search: "red car" returns red-car clips ranked correctly.
- Spin up a second `fnvr` node, point it at the hub, confirm events + thumbs replicate; pull a remote clip on demand and confirm it streams back.

**Load / longevity:**
- 24-hour soak test at 32 × 1080p streams — assert no memory growth, no decoder resets beyond expected reconnects, no dropped segments, GPU thermal within spec.
- Disk-fill test: fill to 95 %, confirm purge policy engages, confirm alarm.
- Power-loss test (UPS triggers NUT shutdown): confirm clean segment close, DB consistent, pipeline resumes on boot.

## 12. Deliberate Non-Goals for v1

- Non-NVIDIA acceleration (AMD / Intel / CPU-only). Design leaves the door open but v1 is Jetson-first.
- Multi-tenant SaaS hosting. Federation yes; multi-tenant billing no.
- Mobile native apps. PWA + push is enough for v1; native apps post-v1.
- Hardware-locked commercial licensing. v1 is AGPLv3; commercial tier comes later if at all.
- HomeKit Secure Video (MFi concerns + narrow audience).
- GB28181 native server implementation (document it as a planned ingest source, not delivered in v1).
