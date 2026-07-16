# Batched-mux: before/after on the real fleet — 2026-07-16

Same host (shodan, GB10), same 7 real cameras, same models (yolo26x
FP16, interval=0), same 60 s `capture-dgx.sh` methodology. Raw captures:
`before-batched-mux-2026-07-16.txt`, `after-batched-mux-2026-07-16.txt`.

Fleet: 5 inference cameras (2× shape "all" incl. a 4K H.265 and a
4608×1728 panorama; 3× "object+face" H.265), 1 record-only, 1
record-only+rotation-180 (transcode). Before: 7 per-camera workers,
batch-size=1. After: 4 group workers (groups of 2 + 3, two solos),
one shared b8 dynamic engine.

## Results

| metric                        | before      | after       | Δ |
|-------------------------------|-------------|-------------|---|
| pipeline worker processes     | 7           | 4           | −43% |
| inference-worker RSS (sum)    | ~5.35 GB (5×~1.07 GB) | ~2.51 GB (2 workers) | **−53%** |
| pipeline RSS incl. solos      | ~7.4 GB     | ~2.96 GB    | **−60%** |
| GPU SM mean / max             | 65.1% / 90% | 64.2% / 86% | ≈unchanged |
| NVDEC mean                    | 18.8%       | 15.6%       | −17% (partly scene variance) |
| NVENC mean                    | 1.3%        | 1.5%        | unchanged (1 transcode cam) |
| detections attribution        | per-camera  | per-camera  | verified identical semantics |

## Reading the numbers honestly

**Memory is the structural win.** Every batchable camera used to cost a
full worker: its own CUDA context, its own deserialised TRT engine,
its own GStreamer stack (~1.05 GB RSS each). In a group, those are
shared — the 3-camera group weighs ~1.26 GB total, i.e. each
*additional* camera now costs ~10–100 MB instead of ~1 GB. Extrapolated
to the 16-camera design point: ~16 GB of pipeline RSS before vs ~4 GB
after, leaving unified memory free for bigger models (Phase 3) and
Postgres (Phase 4).

**SM did not move, and that's informative.** The pgie runs its 640×640
network per frame regardless of batching — total FLOPs are identical,
and batch-size only removes per-dispatch overhead, which is negligible
on Blackwell-class SMs (unlike the Orin, where dispatch efficiency was
the expected win per the 2026-05-03 baseline analysis). Conclusion for
capacity planning: on GB10 the compute levers are `interval=N`, FP8/
NVFP4 quantisation, and model size (Phase 3/4) — NOT further batching.

**Fault-domain gains (not in the table).** Verified in drills on this
deploy:
- A member whose stream goes silent flips to `failed` alone (per-member
  heartbeat); siblings keep running in the same process.
- A member whose source chain hard-errors is attributed by element
  name, quarantined (60 s → 10 min backoff), and the group respawns
  WITHOUT it; re-admission goes through a solo probation group that
  only graduates on a written healthy-marker (PLAYING + frames — mere
  uptime proved to be a lying signal and caused one premature rejoin
  before the marker fix).
- Group restarts on config edits / new-camera joins blip co-members
  ~5–10 s (documented semantic).
- Hourly worker rotation (Orin-era leftover) is gone entirely.

**Letterbox correctness.** Multi-member canvases letterbox mixed-AR
sources; verified with real pixels (panorama preview JPEG) that legacy
nvstreammux anchors top-left / pads bottom-right — `kMuxPadsCentered=false`
in pipeline.cpp, and published bboxes are normalised to source space
via the inverse mapping.
