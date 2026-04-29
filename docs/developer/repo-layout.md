# Repo layout

Monorepo. One Taskfile + one docker-compose, every service is its own directory.

```
.
├── apps/
│   ├── api-server/              # Go: REST + SSE + /metrics, auth, RBAC, settings
│   │   ├── cmd/api/             # main.go
│   │   ├── internal/
│   │   │   ├── auth/            # sessions, tokens, RBAC, middleware
│   │   │   ├── calibration/     # INT8 frame sampler (see known-issues.md)
│   │   │   ├── camera/          # CRUD + JetStream-backed state tracker
│   │   │   ├── classes/         # editable detection-class taxonomy (YOLO 80 default)
│   │   │   ├── config/          # envOr-based Config + DataDir
│   │   │   ├── db/migrations/   # goose migrations — NEVER rewrite a landed migration
│   │   │   ├── detections/      # detections store + SSE event bus
│   │   │   ├── events/          # NATS subject bus + SSE fanout
│   │   │   ├── flags/           # operator-flagged false-positive labels
│   │   │   ├── health/          # /health + /readyz
│   │   │   ├── metrics/         # Prometheus wrappers + middleware
│   │   │   ├── mlworker/        # HTTP client for ml-worker sidecar
│   │   │   ├── mtxproxy/        # MediaMTX path reconciler (re-mux toggle)
│   │   │   ├── notifications/   # channels + subscriptions store
│   │   │   ├── persons/         # face embeddings + clusters + erasure
│   │   │   ├── pipeline/        # pipeline state + grpc-ish client
│   │   │   ├── plates/          # plate hotlist + recent search
│   │   │   ├── rules/           # rules + zones + incidents store
│   │   │   ├── segments/        # segment index from MediaMTX recordings
│   │   │   ├── server/          # all HTTP handlers here; one file per concern
│   │   │   ├── settings/        # key/value store + typed helpers
│   │   │   ├── snapshot/        # live-JPEG snapshots + face thumbnails
│   │   │   └── system/          # /system/info, /system/storage, disk stats
│   │   └── README.md
│   │
│   ├── event-processor/         # Go: rules engine, face matcher, drift subscriber
│   │   ├── cmd/main.go
│   │   ├── internal/
│   │   │   ├── metrics/         # Prometheus for :9091
│   │   │   ├── rules/engine.go  # THE rules engine — 1500+ lines, one file
│   │   │   └── sidecar/writer.go # per-segment JSONL sidecars
│   │   └── README.md
│   │
│   ├── ml-worker/               # Python FastAPI sidecar
│   │   ├── fnvr_ml/
│   │   │   ├── app.py           # /embed, /cluster, /drift/run
│   │   │   ├── inference.py     # CPU onnxruntime SCRFD + ArcFace
│   │   │   ├── clusters.py      # HDBSCAN nightly pass
│   │   │   ├── drift.py         # weekly self-match check → NATS
│   │   │   ├── scheduler.py     # APScheduler wiring
│   │   │   └── tao_stub.py      # fine-tune scaffold (see PLAN.md M4)
│   │   └── pyproject.toml
│   │
│   ├── notification-dispatcher/ # Go: NATS → webhook/ntfy/mqtt/HA
│   │   └── internal/channels/dispatcher.go
│   │
│   ├── pipeline-supervisor/     # C++ / DeepStream
│   │   ├── CMakeLists.txt
│   │   └── src/
│   │       ├── main.cpp           # parent supervisor + per-worker launch
│   │       ├── pipeline.cpp       # per-camera GStreamer graph
│   │       ├── face_crop_jpeg.*   # GPU crop + libjpeg-turbo encode (separate TU)
│   │       ├── object_phash.*     # perceptual hash for detection dedup
│   │       ├── hailo_probe.*      # tracker-output probe → hailo-broker socket
│   │       ├── hailo_inference.*  # broker client (wire.h protocol)
│   │       ├── rtsp_probe.*       # codec auto-detection preamble
│   │       ├── db_reconciler.*    # libpq camera-config sync
│   │       ├── nats_publisher.*   # hardened NATS wrapper (see pipeline.md)
│   │       └── config.*           # YAML config
│   │
│   ├── hailo-broker/            # C++: owns /dev/hailo0, serves unix-socket inference RPC
│   │   ├── CMakeLists.txt
│   │   └── src/
│   │       ├── main.cpp
│   │       ├── hailo_inference.* # libhailort wrapper, batch-of-4 policy
│   │       └── wire.h            # request/response framing
│   │
│   ├── storage-manager/         # Go: retention / quota / disk-pressure
│   │   └── internal/lifecycle/lifecycle.go
│   │
│   ├── web/                     # React + Vite + Tailwind
│   │   └── src/
│   │       ├── components/Layout.tsx
│   │       ├── lib/             # api client, events SSE, useMe
│   │       └── routes/
│   │           ├── live/        # mosaic + BBox overlay
│   │           ├── timeline/    # range-streamed playback + event pins
│   │           ├── events/      # incidents + live detection SSE
│   │           ├── cameras/     # inline zone editor + class mutes
│   │           ├── rules/       # rule form + channel attach
│   │           ├── plates/      # hotlist + recent
│   │           ├── faces/       # Persons, Clusters, UploadEnrolModal, drift pill
│   │           ├── storage/     # disk gauge + per-camera retention/quota editor
│   │           ├── settings/    # detector + channels + users
│   │           └── login/
│   │
│   └── webrtc-signaling/        # deliberately tiny; may fold into api-server
│
├── libs/
│   ├── proto/                   # pipeline.proto + events.proto (buf)
│   └── go-common/               # generated pb.go + shared helpers
│
├── deploy/
│   ├── docker/
│   │   ├── Dockerfile.{api,events,ml,notifications,pipeline,hailo-broker,storage,web}
│   │   ├── docker-compose.yml              # default stack (postgres tuning lives here)
│   │   ├── docker-compose.hailo.yml        # adds hailo-broker + /var/run/fnvr socket mount
│   │   ├── docker-compose.dual-nic.yml     # optional overlay for camera-LAN isolation
│   │   ├── pipeline-entrypoint.sh          # TRT + libv4l shim + INT8 fallback
│   │   ├── calibrate-yolo26.sh             # offline trtexec driver
│   │   └── nginx.conf                      # web container's proxy (api only — media is direct)
│   └── config/
│       ├── fnvr.sample.yaml                # MediaMTX config lives inline in docker-compose.yml as env vars
│       └── nvinfer/                        # DeepStream nvinfer configs
│           ├── yolo26.txt  arcface.txt  scrfd.txt  lpdnet.txt  lprnet.txt
│           └── tracker_NvDCF.yml
│
├── docs/                        # THIS
├── tools/
│   ├── benchmark/               # first-run capacity wizard — README-only so far
│   └── stream-probe/            # "does this RTSP URL work" — README-only so far
├── PLAN.md
├── README.md
└── Taskfile.yml
```

Conventions:
- **One service = one directory under `apps/`.** No shared Go module — each service has its own `go.mod` so compile failures stay local.
- **Handlers under `apps/api-server/internal/server/` are one file per concern.** `persons.go`, `clusters.go`, `drift.go`, `storage.go`, etc. Shared server helpers (auth wrappers, writeJSON) in `server.go`.
- **Web routes under `apps/web/src/routes/<concern>/` are one folder per tab.** A tab with multiple panels gets multiple files in the folder (see faces/).
- **Migrations are append-only and numbered `NNNN_name.sql`.** Goose runs `Up` on api-server start. Never rewrite a committed one — add a new one.
- **Packaging per app** — each dir is its own docker image with a dedicated Dockerfile.
