# Pipeline

The pipeline is a C++ / DeepStream 9.1 GStreamer process (SBSA container on DGX Spark), one child per camera **group**. Cameras whose graphs have the same shape (same detector set, no transcode) share a worker process with one batched `nvstreammux` and one TensorRT engine; bespoke shapes (record-only, rotation/mtx_proxy transcode) stay solo. A supervisor parent plans groups from the DB ([grouping.cpp](../../apps/pipeline-supervisor/src/grouping.cpp)), launches, watches, and restarts children, and quarantines individual members whose source chains fault so one broken camera cannot keep restarting its healthy siblings.

## Group GStreamer graph (batched-mux)

```
  per member i (codec auto-detected per camera by an ffprobe preamble):
  rtspsrc (camera i) → rtp{h264,h265}depay → {h264,h265}parse → tee t_i
        ├─ queue (8, leaky) → nvv4l2decoder → queue → mux.sink_i
        └─ queue (200, leaky) → {h264,h265}parse config-interval=-1
                → rtspclientsink → rtsp://mediamtx:8554/live_<cam_i>   (RECORD + WebRTC)

  shared, once per group:
  nvstreammux (batch-size=N, canvas 1920×1080, enable-padding=1)
    → nvinfer  pgie   (yolo26, one b$BATCH engine shared by the group)
    → nvtracker  (NvDCF; per-source track state is native)
    → nvinfer  lpdnet/lprnet   (plate SGIEs, optional — group shape)
    → nvinfer  scrfd/arcface   (face SGIEs, optional — group shape)
    → fakesink                                  (detection probe taps here)
  (a pad probe on pgie.src — see preview_probe.cpp — walks the batch and
   writes each member's 1 fps 480×270 JPEG ring. No second decode.)
```

Actual construction lives in [apps/pipeline-supervisor/src/pipeline.cpp](../../apps/pipeline-supervisor/src/pipeline.cpp) (`GroupPipeline`). Mixed codecs within one group are fine — depay/parse are per-member; only the decoded NVMM surfaces meet at the mux.

**Letterbox + bbox mapping.** A single-member group keeps its native resolution as the mux canvas (no letterbox). Multi-member groups share a fixed 1920×1080 canvas: each source is aspect-preserving scaled and padded. Empirically verified on DS 9.1 (a 4608×1728 panorama scaled to 1920×720): the legacy mux anchors content **top-left and pads bottom/right** — `kMuxPadsCentered=false` in pipeline.cpp encodes this; the detection probe inverts the mapping so published bboxes are normalised to SOURCE space, and GPU crops use canvas space (the batched surface). Object metadata is attributed to members via `frame_meta->pad_index`.

**Group restart semantics.** Editing a member's restart-relevant config (url, detectors, rotation, mtx_proxy) — or **adding a new camera that plans into an existing group** — restarts that group (~5–10 s blip for its members). Solo/bespoke cameras never affect others.

**Member-fault quarantine.** A bus ERROR attributable to one member's source chain (elements are named `src_i/dec_i/…`) makes the child publish that camera's `failed`, write a fault marker, and exit rc=4; the supervisor quarantines the member (60 s backoff doubling to 10 min) and respawns the group WITHOUT it. On expiry the camera is re-admitted through a solo **probation** group; it graduates back into its natural group only after the child writes its healthy marker (PLAYING + frames flowing — uptime alone is not a health signal). The quarantine map is in-memory: a pipeline-container restart forgets it and re-learns within one fault cycle (~20 s). A member whose stream merely goes SILENT (publisher vanished but transport stays up) doesn't error the group at all — the per-member heartbeat flips it to `failed` while its siblings keep running.

Per-camera choices baked into the graph:
- **Codec passthrough.** The recording branch pushes the source elementary stream into MediaMTX unchanged. We do **not** transcode H.265 → H.264 anymore — saves ~40% NVENC and lets MediaMTX hand the same elementary stream to both fMP4 recording and the WebRTC live view.
- **MediaMTX as the media hub.** A single `mediamtx` sidecar terminates the supervisor's `rtspclientsink` push, persists fMP4 segments to disk via its built-in recorder, and serves WebRTC live (`:8889`) and chunked fMP4 playback (`:9996`) directly to the browser. The api-server is no longer in the media path — see [data-model.md](data-model.md) for the URL surface.
- **Aspect ratio.** Preserved end-to-end; the live mosaic tiles letterbox non-16:9 cameras rather than stretching.
- **USB cameras** come in via the same `mediamtx` sidecar (a `usb-bridge` profile re-publishes the V4L2 source as RTSP), so the pipeline code path is identical for USB and IP cameras.

## Detections → NATS

Each `nvinfer` + tracker hit is attached to the buffer as `NvDsObjectMeta`. A bus-watch probe after the trackers walks the metadata, builds a [`Detection` payload](../../apps/event-processor/internal/rules/engine.go), and publishes it on `fnvr.events.detection.<camera_id>`. Face probes additionally extract the 512-d ArcFace embedding from tensor-meta and base64-encode it into `attributes.embedding` for the matcher to read downstream.

The probe does NOT query the DB. Person labels are resolved afterwards in [event-processor](rules-engine.md) so the pipeline stays stateless.

A thumbnail JPEG is cropped directly on the GPU via `NvBufSurfTransform` for every face detection and written to `/var/lib/fnvr/thumbs/faces/<detection-event-id>.jpg`. Event-processor renames this on insert to `<pg-detection-id>.jpg` so the thumbnail URL is stable.

## Live view + playback (via MediaMTX)

The browser talks **directly** to MediaMTX, not through the api-server. Two endpoints on the docker host's LAN:

- **Live (WebRTC).** `https://<host>:8889/live_<camera_id>/whep` — browser issues a WHEP `POST` with its SDP offer; MediaMTX answers, the camera stream flows over a peer connection. CORS is open to private LAN ranges; ICE candidates advertise the host's LAN IP via `webrtcAdditionalHosts` in [deploy/config/mediamtx.yml](../../deploy/config/mediamtx.yml).
- **Timeline playback.** `https://<host>:9996/get?path=live_<camera>&start=<ts>&duration=<sec>` — chunked fMP4 streaming from the on-disk recordings MediaMTX persisted while the camera was live.

There is **no WHEP server inside the supervisor anymore**. The dead bind-and-proxy code path was removed in commit `5eac780`; api-server's old `/api/v1/whep/*` routes and the C++ `whep_server.cpp` are gone.

Per-browser playback loaders live in [apps/web/src/routes/timeline/Timeline.tsx](../../apps/web/src/routes/timeline/Timeline.tsx) — Chrome uses native `<video src>`, Firefox uses MSE (chunked-without-Range support is patchy), Safari fetches the whole window into a Blob (it refuses the streaming 200 responses MediaMTX returns without a `Range` header).

## Camera health heartbeat

Every group worker publishes per-member `{"camera_id":"...","state":"running"}` to `fnvr.state.camera.<id>` on a 30 s loop once the pipeline reaches `GST_STATE_PLAYING` **and that member's frames are advancing** (the detection probe bumps a per-source counter). A member stalled >60 s while the group plays gets `failed` — its siblings stay `running`. The api-server stores these in a JetStream last-value stream (`FNVR_CAMERA_STATE`, `MaxMsgsPerSubject=1`) so a restart replays the latest state per camera immediately instead of waiting for the next heartbeat.

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

## Hourly segment rotation (removed)

The Orin build restarted every worker hourly so recordings landed in per-hour `rec.mp4` directories. Recording moved to MediaMTX (which segments on its own `MTX_RECORDSEGMENTDURATION=1h` clock) long ago, so the batched-mux rework deleted the rotation entirely — group workers run until a fault or a config change stops them.

## Detector backend

The pgie is always NVIDIA's `nvinfer` running a TensorRT engine on the GPU. Detection metadata appears as `NvDsObjectMeta` and the standard probe walks it.

(The Orin build carried a parallel Hailo-8 PCIe accelerator path because the Orin GPU ran out of headroom; on DGX Spark the Blackwell GPU vastly outclasses it, so that path — hailo-broker container, in-pipeline probe, HEF compile toolchain, per-camera `detector_backend` — was removed.)

## First-run engine compilation

DeepStream `nvinfer` elements lazy-compile their TensorRT engines on first use (cached thereafter under `/var/lib/fnvr/models/yolo26/*.engine`; the Orin took ~30 s per worker for yolo26x — re-measure on the Spark). The container entrypoint publishes `{"state":"starting"}` heartbeats during compile, and the UI's 15-min "starting" freshness window covers that.

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
3. **Data-flow watchdog (currently disabled).** A pad-probe-driven flow counter (see `buffersPassed_` in [pipeline.h](../../apps/pipeline-supervisor/src/pipeline.h)) is preserved in the source. It used to bump on the record-branch `h264parse` and the [main.cpp](../../apps/pipeline-supervisor/src/main.cpp) flow-watchdog thread sampled it every 5 s, hard-exiting on a 20 s stall. The probe target element (`recparse`) was removed when the recording branch moved to `rtspclientsink → MediaMTX`. The counter is kept because it's the only path that catches silent stalls (the bus never fires ERROR when the wedge is inside an NVIDIA library syscall); it needs re-pointing at a still-flowing pad such as `tracker.src` or the rtspclientsink request pad before the watchdog thread can be re-enabled.

Log trail (look for these in `docker logs fnvr-pipeline-1 | grep worker`):
- `worker[X]: did not reach PLAYING within 60s — faulting` — startup watchdog
- `worker[X]: hard-exit rc=3 (bus error)` — bus error fired
- `worker[X]: hard-exit rc=3 (EOS)` — source stream ended
- `worker[X]: data-flow stalled 20s — hard exit rc=3` — silent stall

In all cases the supervisor respawns via the fork+exec loop in [supervisor.cpp](../../apps/pipeline-supervisor/src/supervisor.cpp), and the flapping detector (`≥3 exits in 60 s → publish "failed"`) prevents a reliably-broken source from silently respawning forever.

## Capacity

With YOLO26x FP16 on an Orin AGX 64 GB at nvpmodel MAXN, 3 × 1080p cameras at 10 fps ingest use roughly half the GPU. Adding ANPR + face-ID roughly doubles the load. Real numbers come from `tegrastats` + `/metrics`; the [benchmark tool](../../tools/benchmark/) (not yet shipped) will automate this.

INT8 yolo26x calibration is blocked on [TRT 10.3 bug #3937](../operations/known-issues.md), not on our code. Resume path: JetPack 7.2 (Q2 2026).
