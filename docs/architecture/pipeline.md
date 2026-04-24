# Pipeline

The pipeline is a C++ / DeepStream 7 GStreamer process, one child per camera. A supervisor parent launches, watches, and restarts children. Each camera is isolated: a single bad RTSP feed cannot take the stack down.

## Per-camera GStreamer graph

```
  uridecodebin (RTSP / MediaMTX-proxied USB)
    → h264parse (or h265parse, codec-autodetected by ffprobe)
    → tee
        ├─ nvv4l2decoder → nvstreammux (batch 1)
        │                → nvinfer  pgie   (yolo26 detector)
        │                → nvtracker  (NvDCF, IDs + bbox smoothing)
        │                → nvinfer  lpdnet (plate detector SGIE, optional)
        │                → nvinfer  lprnet (plate OCR SGIE, optional)
        │                → nvinfer  scrfd  (face detector SGIE, optional)
        │                → nvinfer  arcface (face embedder SGIE, optional)
        │                → nvvideoconvert
        │                → nvv4l2h264enc
        │                → h264parse → qtmux
        │                → filesink  (hourly-rotated rec.mp4)
        ├─ videorate → jpegenc → multifilesink (low-fps JPEG preview ring)
        └─ rtph264pay → tee + fakesink   (WHEP subscribers tap in here)
```

Actual construction lives in [apps/pipeline-supervisor/src/pipeline.cpp](../../apps/pipeline-supervisor/src/pipeline.cpp). Codec auto-detection — so H.264 *and* H.265 sources both work — is in `pipeline.cpp`'s preamble via a small `ffprobe` run before the pipeline is built.

Per-camera choices baked into the graph:
- **Codec.** Recording is always H.264 regardless of source, so the browser can play segments back natively (no decoded-via-WASM fallback). H.265 sources are transcoded once in the pipeline on the NVENC.
- **Aspect ratio.** Preserved end-to-end; the live mosaic tiles letterbox non-16:9 cameras rather than stretching.
- **USB cameras** come in via a `mediamtx` sidecar that re-publishes a V4L2 webcam as RTSP on the internal docker network, so the pipeline code path is the same for USB and IP cameras.

## Detections → NATS

Each `nvinfer` + tracker hit is attached to the buffer as `NvDsObjectMeta`. A bus-watch probe after the trackers walks the metadata, builds a [`Detection` payload](../../apps/event-processor/internal/rules/engine.go), and publishes it on `fnvr.events.detection.<camera_id>`. Face probes additionally extract the 512-d ArcFace embedding from tensor-meta and base64-encode it into `attributes.embedding` for the matcher to read downstream.

The probe does NOT query the DB. Person labels are resolved afterwards in [event-processor](rules-engine.md) so the pipeline stays stateless.

A thumbnail JPEG is cropped directly on the GPU via `NvBufSurfTransform` for every face detection and written to `/var/lib/fnvr/thumbs/faces/<detection-event-id>.jpg`. Event-processor renames this on insert to `<pg-detection-id>.jpg` so the thumbnail URL is stable.

## WHEP live view

The RTP tee output feeds a small WHEP server bound to a random port per camera. The api-server's `whep.Registry` ([camera/state.go](../../apps/api-server/internal/whep/registry.go)) tracks port → camera and proxies the browser's SDP offer. No media flows through the api-server — it's pure signaling.

## Camera health heartbeat

Every worker publishes `{"camera_id":"...","state":"running"}` to `fnvr.state.camera.<id>` on a 30 s loop once the pipeline reaches `GST_STATE_PLAYING`. The api-server stores these in a JetStream last-value stream (`FNVR_CAMERA_STATE`, `MaxMsgsPerSubject=1`) so a restart replays the latest state per camera immediately instead of waiting for the next heartbeat.

Stale-heartbeat windows:
- `running`: 10 min
- `starting`: 15 min (first-time TRT engine compiles can take 5–15 min per worker)
- anything else: 2 min

The UI surfaces the stamped time when a camera goes to `unknown`, so "pipeline offline · last heartbeat 12m ago" is visible at a glance.

## Why the NATS client is wrapped

The pipeline uses the `nats-c` library. The default reconnect behaviour gives up after 60 attempts (~2 min), after which `natsConnection_Publish` still returns `NATS_OK` but the messages are dropped into the pending queue and never delivered. [nats_publisher.cpp](../../apps/pipeline-supervisor/src/nats_publisher.cpp) wraps the default:

- Unlimited reconnect (`MaxReconnect=-1`), 8 MB reconnect buffer.
- Explicit `natsConnection_Status == CLOSED` check before every publish, with rate-limited log on detection + automatic rebuild of the connection.

Without this, the detection *and* heartbeat publish paths can silently die without the process noticing — we've hit that in production and spent hours diagnosing it.

## Hourly segment rotation

Each worker is restarted at the top of every hour so recordings land in the new `YYYY/MM/DD/HH/<camera>/rec.mp4` directory. Without this, a worker that's up for 24 h writes a 100+ GB `rec.mp4` into its birth hour's folder and timeline scrubbing breaks.

The rotation is **silent** from the UI's perspective:

- The supervisor passes `--rotation` to the respawned `--worker` child. The child skips its `{"state":"starting"}` publish, so the JetStream last-value stream continues to return the pre-rotation `{"state":"running"}` message until the new worker itself reaches `GST_STATE_PLAYING` and publishes a fresh `running`.
- The api-server's `running` freshness window is 10 minutes; the rotation gap is ~30 s, so `state=running` is honoured continuously.
- Rotation is staggered per-camera — up to 120 s after HH:00, deterministic by `hash(camera_id)` — so even if the silent-publish path regresses, cameras flash individually rather than simultaneously.

Log trail: `docker logs fnvr-pipeline-1 | grep rotation` yields lines of the form `worker[<id>]: hourly rotation — rolled (silent; prior state retained) pid N`. If you see `hourly rotation — restarting pid N` instead, that's the pre-silent-rotation log format and the build is out of date.

A genuine `Start()` failure during rotation still publishes `{"state":"failed"}` — a busted rotation flips the UI red as it should.

## First-run engine compilation

DeepStream `nvinfer` elements lazy-compile their TensorRT engines on first use. For yolo26x on Orin AGX this takes ~30 s per worker (cached thereafter under `/var/lib/fnvr/models/yolo26/*.engine`). The container entrypoint publishes `{"state":"starting"}` heartbeats during compile, and the UI's 15-min "starting" freshness window covers that.

Pre-bake path: a `trtexec` invocation in [deploy/docker/calibrate-yolo26.sh](../../deploy/docker/calibrate-yolo26.sh) can produce the engine ahead of time.

## Secondary inference (SGIEs)

ANPR and face-ID run as secondary `nvinfer` elements chained after the primary detector + tracker. They only process objects whose class ID matches their "operate-on" list (cars for LPDNet, persons for SCRFD), so the per-frame GPU cost on a camera with no candidates in frame is near zero — but the engine still sits in memory and the nvstreammux batch still binds to it, so *presence* in the graph has non-trivial cost.

Per-camera enable/disable is effective-min of two controls:
- **Pipeline-level kill switches** — `settings.detector.anpr_enabled` / `settings.detector.face_id_enabled`. Off = every worker's graph omits that SGIE chain. Flipping these restarts the whole pipeline container.
- **Per-camera whitelist** — `cameras.enabled_detectors` (text array). Stored encoding:
  - `[]` — all SGIEs permitted (friendly default for new rows)
  - `["object","face"]` — whitelist; each listed kind enables its SGIE chain
  - `["none"]` — explicit no-inference tier (see below)

A camera only gets the ANPR chain (LPDNet + LPRNet) when the pipeline-level kill-switch is on AND `"anpr"` is in its whitelist (or the whitelist is empty). Same for face (SCRFD + ArcFace). The supervisor respawns only the affected worker when `enabled_detectors` changes, leaving the other cameras untouched.

## No-AI tier

When `enabled_detectors = ["none"]`, the pipeline builds a dramatically shorter graph for that camera:

- **No inference branch.** No nvv4l2decoder on the record side (when rotation=0), no nvstreammux, no pgie, no nvtracker, no SGIEs, no NVENC. The source H.264 is passed straight from the pre-tee parser into qtmux → filesink. Cheapest possible path — only the RTSP demux + h264parse + muxing runs per-frame.
- **Rotation still works.** If a no-AI camera has `rotation != 0`, the pre-tee transcode path (decode → nvvideoconvert flip-method → NVENC) still runs; the record branch then passes the re-encoded H.264 through qtmux with no inference attached.
- **Live preview + WHEP unchanged.** Both branches tap from the same `tee` before inference ever runs, so preview JPEGs and WHEP live video work identically to a full-inference camera.
- **No NATS publishing.** The InferSrcProbe is not attached (there's nothing to probe), so no `fnvr.events.detection.<cam>` messages come from this worker. Upstream consumers (event-processor, SSE, HA bridge) see nothing for it.

Use case: cameras that exist for recording + monitoring but don't need detection (e.g. a garage camera you only look at when something happened), or sources whose H.264 is too corrupt for NVDEC to handle reliably.

## Watchdogs + hard-exit policy

Three independent failure-detection paths in each worker. All converge on `std::_Exit(3)` — bypass at-exit destructors that might themselves deadlock on the same stuck resource, and let the supervisor's existing respawn + backoff + flapping-detection handle recovery.

1. **Startup PLAYING watchdog** ([main.cpp](../../apps/pipeline-supervisor/src/main.cpp) `stop_watcher` thread). Faults and publishes `failed` if the pipeline hasn't reached `GST_STATE_PLAYING` within 60 s of `Start()`. Catches `rtspsrc` SETUP hangs that `tcp-timeout=15s` doesn't catch.
2. **Bus error** ([pipeline.cpp](../../apps/pipeline-supervisor/src/pipeline.cpp) `BusHandler`). On any `GST_MESSAGE_ERROR` or `GST_MESSAGE_EOS`, publishes `failed` and hard-exits. Does **not** call `gst_element_set_state(NULL)` — that path blocked the process for 37 min once when an NvMedia element was wedged. Respawn is faster than graceful shutdown anyway, and a broken pipeline has nothing worth draining.
3. **Data-flow watchdog** ([main.cpp](../../apps/pipeline-supervisor/src/main.cpp) `flow_watchdog` thread + [pipeline.cpp](../../apps/pipeline-supervisor/src/pipeline.cpp) `AttachFlowCounter`). A pad probe on the record-branch `h264parse` (`recparse`) bumps an atomic counter on every buffer; the watchdog samples every 5 s and hard-exits if the counter hasn't advanced in 20 s while the pipeline is `PLAYING`. Catches silent stalls — the case where the bus never fires ERROR because the wedge is inside an NVIDIA library syscall.

Log trail (look for these in `docker logs fnvr-pipeline-1 | grep worker`):
- `worker[X]: did not reach PLAYING within 60s — faulting` — startup watchdog
- `worker[X]: hard-exit rc=3 (bus error)` — bus error fired
- `worker[X]: hard-exit rc=3 (EOS)` — source stream ended
- `worker[X]: data-flow stalled 20s — hard exit rc=3` — silent stall

In all cases the supervisor respawns via the fork+exec loop in [supervisor.cpp](../../apps/pipeline-supervisor/src/supervisor.cpp), and the flapping detector (`≥3 exits in 60 s → publish "failed"`) prevents a reliably-broken source from silently respawning forever.

## Capacity

With YOLO26x FP16 on an Orin AGX 64 GB at nvpmodel MAXN, 3 × 1080p cameras at 10 fps ingest use roughly half the GPU. Adding ANPR + face-ID roughly doubles the load. Real numbers come from `tegrastats` + `/metrics`; the [benchmark tool](../../tools/benchmark/) (not yet shipped) will automate this.

INT8 yolo26x calibration is blocked on [TRT 10.3 bug #3937](../operations/known-issues.md), not on our code. Resume path: JetPack 7.2 (Q2 2026).
