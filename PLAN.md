# fnvr-dgx — plan & status

This fork retargets [fyrbyAdditive/fnvr](https://github.com/fyrbyAdditive/fnvr)
(Jetson AGX Orin) to the **NVIDIA DGX Spark** (GB10 Grace Blackwell,
128 GB unified memory, DeepStream 9.1 SBSA) and then keeps evolving as
the production NVR for a real seven-camera deployment. The original
greenfield plan this file used to hold is in git history
(`git log -- PLAN.md`); everything below reflects what actually
exists.

## Status: the retarget is complete and live

All phases were built, deployed, and verified on real hardware
("shodan", the production DGX Spark) during 2026-07.

| Phase | Outcome |
|---|---|
| **1. Platform port** | DS 9.1 SBSA container, Hailo path removed, CUDA-unified surface allocation + per-thread GPU transform sessions, all bases modernised (pg18, Go 1.26, Node 24). Fault drills passed. |
| **2. Batched mux** | Cameras grouped by graph shape into shared `nvstreammux` workers (7 cams → 4 workers, pipeline RSS −60%). Strike-based member quarantine with probation, fault-storm suppression, escalating heal ladder, push-relay watchdogs. GB10 lesson: capacity is FLOPs-bound at the network input, not batch-bound. |
| **3. Model refresh** | **RF-DETR base** as primary detector (3× the headroom of yolo26x, better recall; fleet default), served by **Triton** (`nvinferserver` gRPC, one engine + one CUDA context for the whole fleet). Global ANPR (open-image-models + fast-plate-ocr). FP8 PTQ evaluated and **rejected** on output parity — fp16 stays (see [tools/benchmark/](tools/benchmark/)). |
| **4. Optimisation sprint** | NVENC low-bitrate live-proxy streams for the grid; per-frame batched detection publishing; probe-side publish thinning (~99% fewer redundant object rows); GPU JPEG (nvjpeg) for all crops/previews; playback transcoder for non-HEVC browsers; retro-analytics replay; substream inference (zero main-stream decode); per-member Prometheus pipeline metrics. |

## Feature log (2026-07, this fork)

- **Timeline overhaul** — three-band ruler (recording / events /
  activity density), frame-accurate playback (MediaMTX honours
  sub-second starts), per-track runs when zoomed.
- **Settings rework** — advanced-settings whitelist with grouped,
  hint-rich UI; detector family/variant/interval/backend switching
  from the UI.
- **Live view modernisation** — proxy-stream grid, camera control
  popup (enable, per-camera detectors, label-box, hide), overlays
  with per-kind colouring.
- **Face stack rebuilt (the aligned stack)** — root-caused why the
  inherited stack underperformed (no landmark alignment anywhere,
  detector was actually RetinaFace MNet-0.25, ~97% junk captures).
  Now: real SCRFD-10G in-graph (bbox-only, own parser), per-track
  capture limiting (best-of-window), embedding moved OUT of the
  graph — ml-worker re-detects landmarks on the published crop,
  aligns (ArcFace template), embeds **TopoFR R100** via a JetStream
  work queue, and republishes; event-processor unchanged. Live and
  upload paths share one implementation. Matching: top-3-mean +
  runner-up margin + same-space negative veto + per-track decayed
  aggregation. Enrolment: diversity pruning, quality gates
  (det-score/yaw/blur), retro-match on enrol, HDBSCAN stranger
  clusters, GDPR erasure. Measured: same person across scenes ~0.7
  cosine (was 0.45–0.58), different people ≤0.1; threshold 0.55.
- **Print-failure monitoring** — Obico's 2nd-gen spaghetti model
  (the only open model with a real evidence base: >90% catch / <5%
  FP across 80M+ community print-hours) runs GPU-side via Triton on
  the preview frames of printer-pointed cameras; EWM-smoothed scoring
  with hysteresis feeds a `print_failure` class the rules engine
  alerts on. Notify-only by explicit decision — no printer control.
- **Reliability arc** — documented in
  [docs/operations/known-issues.md](docs/operations/known-issues.md):
  GB10 unified-memory nvinfer pool-guard false positive
  (`max-gpu-mem-per=100` everywhere), DS 9.1 parser-returns-false
  segfault, tracker off-canvas rects vs SGIE crops (rect-clamp
  probe), LATENCY-message recalculation for push relays, WiFi
  power-save + DFS channel-switch flapping (host-level).

## Architecture (current)

See [docs/architecture/](docs/architecture/) for detail. In one
paragraph: a C++ pipeline-supervisor plans camera groups from
Postgres and runs one DeepStream worker process per group
(RF-DETR pgie via Triton gRPC → NvDCF tracker → optional ANPR SGIEs →
optional SCRFD face SGIE), publishing detections per-frame to NATS;
Go services (api-server, event-processor, storage-manager,
notification-dispatcher) handle API/auth, rules→incidents→alerts,
retention, and channel fan-out; a Python ml-worker owns everything
model-adjacent that doesn't belong in the graph (face align+embed,
clustering, drift, print-failure monitoring, photo enrolment); React
web UI on top. Datastores: Postgres (+pgvector), NATS JetStream,
fMP4 segments on disk.

## Open items

Near-term, concrete:
- Watch the aligned face stack over a normal week (threshold 0.55,
  capture volume, cluster quality) and retune defaults if needed.
- Live spaghetti test of print monitoring (wave a failed print at a
  printer cam); configure a notification channel for the rule.
- `GROUP_MAX` → 16 when more cameras arrive; per-camera preview
  resolution override if 480×270 proves tight for print monitoring.
- Optional phase 2 for print monitoring: PrusaLink auto-pause behind
  a setting (deliberately not built — notify-only was the decision).

Infrastructure (host-level, tracked in known-issues):
- Wire shodan's spare NIC to a routable segment (WiFi is the current
  uplink; big host downloads can starve 4K camera streams).
- Pin the mesh AP to a non-DFS channel.

Upstream reports worth filing to NVIDIA: unified-memory pool-guard
false positive, parser-false free() crash, tracker off-frame rects
vs SGIE crops, cudaIpc-on-iGPU limitation.

## Non-goals

Inherited from upstream and still true here: no non-NVIDIA
acceleration, no multi-tenant SaaS, no native mobile apps (PWA is
fine), no HomeKit Secure Video. Added by this fork: no cloud
dependency of any kind — every model runs locally, and features that
would require phoning home (cloud failure detection, remote access
relays) are out of scope by design.
