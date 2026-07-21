# Changelog

## 0.1.1 — 2026-07-21

First tagged release of the DGX Spark fork. Everything below landed
since `v0.0.1` (the pre-fork Jetson baseline) and runs verified on a
real seven-camera deployment.

### The platform: Jetson → DGX Spark (GB10)

- Full retarget to the DeepStream 9.1 SBSA container on Grace
  Blackwell: Hailo path removed, CUDA-unified surface allocation,
  GPU-compute transforms, modernised bases (PostgreSQL 18, Go 1.26,
  Node 24, Python 3.13).
- Cameras are grouped into **batched multi-camera workers** by graph
  shape (7 cameras → 4 workers, −60% pipeline memory), with
  strike-based member quarantine, fault-storm suppression, an
  escalating self-heal ladder, and push-relay watchdogs — one bad
  camera can no longer take siblings down.
- **RF-DETR** is the primary detector (3× the headroom of YOLO26x
  with better recall), served fleet-wide by a shared **Triton**
  instance over gRPC. FP8 quantisation was evaluated and rejected on
  output parity — fp16 stays.
- Substream inference: cameras with a low-res substream decode only
  that for AI while the full-quality main stream is relayed and
  recorded untouched.
- Per-member pipeline metrics (input/inference/push fps) exported to
  Prometheus.

### Watching it live

- The camera grid now plays dedicated **NVENC low-bitrate proxy
  streams** (~10× less bandwidth, no B-frame/GOP browser pain);
  enlarging a tile switches to the full-quality passthrough.
- Live overlays with per-kind colouring, camera control popup
  (enable, per-camera detectors, label-box, hide), connection-state
  UX, real fps readouts.
- On-demand NVDEC→NVENC transcoding lets browsers without H.265
  support play recordings.

### Timeline

- **All-cameras overview**: the timeline now opens on a stacked
  per-camera lane view — recording coverage, activity density
  (normalised across the fleet), and severity-coloured event markers
  — sharing one time axis, zoom and cursor. Click a lane to play
  that camera at that moment; click the camera name to drill into
  the classic per-camera view *with the cursor and zoom preserved*.
- **Global events digest**: a chronological day-log beside the
  player listing incidents *and* notable detections (recognised
  faces, plate reads, print-failure sightings) across all cameras,
  collapsing repeats, following the zoom, hover-synced with the
  ruler, with inline acknowledge.
- Frame-accurate seeking, three-band per-camera ruler (recording /
  events / activity), track-run view under 2-hour zoom, keyboard
  stepping, and shareable `?camera=&day=` URLs.
- Retro-analytics: replay any recording back through today's
  detector stack (GPU-polite — it throttles itself under live load).

### Face recognition, rebuilt

The inherited stack was structurally broken (no landmark alignment
anywhere, a mislabelled 2019 detector, ~97% junk captures). Replaced
end to end:

- **SCRFD-10G** face detection in-pipeline with per-track capture
  limiting (best face per window instead of hundreds per walk-by).
- Embedding moved out of the video pipeline: an async worker aligns
  each face crop (ArcFace 5-point) and embeds with **TopoFR R100**
  (NeurIPS 2024) — live captures and photo uploads share the exact
  same code path. Same-person similarity went from ~0.5 to ~0.7;
  different people sit below 0.1.
- Matching: top-3-mean per person with runner-up margin, negative
  veto, per-track aggregation, and **retro-matching** — enrolling
  someone automatically claims their earlier sightings.
- Enrolment quality: diversity pruning (near-duplicate samples are
  skipped), quality gates (detector score / head turn / blur), a
  redesigned Faces page with a unified review queue, recurring-
  stranger clusters, bulk triage, and one-click GDPR erasure.

### 3D-printer monitoring (new)

- **Spaghetti / print-failure detection** on printer-pointed cameras
  using Obico's community-proven model (>90% catch rate across 80M+
  community print-hours) — running locally on the GPU via Triton
  with automatic CPU fallback, no cloud, no subscription.
- Smoothed scoring with hysteresis so one noisy frame never alerts;
  failures raise a rule-driven incident (notify-only by design — the
  printers are never touched). Tunables in Settings → Advanced.
- Ships with the **December 2025 model weights** — Obico only
  publishes these in Darknet format, so this release includes a
  parity-verified converter; the new weights score ~7× stronger on
  real spaghetti and eliminated our measured false-positive floors.

### Rules, events, storage

- Sequence rules (cross-camera ordered sightings), alarm states
  (home/away/disarmed) gating rules, incident merging, object-flag
  suppression (flag a false positive once, similar ones are dropped
  by perceptual hash).
- Per-frame batched detection publishing and probe-side publish
  thinning (~99% fewer redundant rows from parked objects).
- GPU JPEG (nvjpeg) for all previews and crops; face-crop retention
  with enrolment-aware pruning; detection classes taxonomy enforced
  at runtime.

### Notable fixes (the hard-won ones)

- GB10 unified memory: nvinfer's output-pool guard misreads free
  system RAM as free VRAM and starves itself — worked around across
  every model config (`max-gpu-mem-per=100`).
- DeepStream 9.1 segfaults if a custom parser returns false;
  tracker-predicted rectangles off the canvas are group-fatal for
  SGIE crops — both fixed at the source.
- Push relays trickling at 1–2 fps after restarts (missing GStreamer
  latency recalculation) — the "flickering feeds" saga, fully fixed
  and watchdogged.
- Host-level camera flapping traced to WiFi power-save and DFS
  channel switches on the mesh AP.

*Earlier history (the upstream Jetson project through `v0.0.1`) is in
git.*
