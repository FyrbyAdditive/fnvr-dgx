# Face-ID

Face identification is a four-stage chain: **detect (in-graph) →
align + embed (ml-worker, async) → match (event-processor)**.
Enrolments and dismissals live in Postgres.

Rebuilt in the 2026 aligned-stack rework. The previous design embedded
in-graph from **unaligned** bbox crops (the detector's landmarks were
computed and then discarded), which cost ~0.2 of same-person cosine and
made the review queue ~97% false positives. Measured after the rework:
same person across different scenes ≈ 0.7, different people ≤ 0.1.

## Models

Bundled under `/var/lib/fnvr/models/faceid/` (seeded from the pipeline
image; both ONNX files are prepped OFFLINE into `deploy/models-cache/`
— see `tools/model-prep/prep_scrfd.py` and `export_topofr.py` for
pinned sources + sha256s):

- **SCRFD-10G-bnkps** (`scrfd_10g_bnkps.onnx`, insightface, ICLR'22) —
  anchor-free face detector with 5-point landmarks. Runs twice, in two
  places:
  - **In-graph** as an `nvinfer` SGIE (FP16, 640×640) on the primary
    detector's person crops — bbox-only gating for capture limiting.
    Our parser (`apps/pipeline-supervisor/nvdsinfer_scrfd/`) ignores
    the `kps_*` tensors: stock DeepStream parsers cannot attach
    per-object landmarks (that limitation is why the old stack lost
    them).
  - **In ml-worker** (CPU ORT, `fnvr_ml/scrfd.py`) on the published
    256×256 crop — recovers the landmarks alignment needs.
  Licence note: insightface pretrained models are non-commercial
  research use — fine for this personal deployment.
- **TopoFR R100 Glint360K** (`topofr_r100.onnx`, NeurIPS 2024) — the
  embedder. 112×112 **ArcFace-aligned** RGB input, `(x/255-0.5)/0.5`,
  512-d output. Runs ONLY in ml-worker (CPU ORT; the GB10's cores do
  ~100-300 ms/face, and capture limiting keeps volume to a trickle).
  Embeddings tagged `model='topofr_r100'` — never comparable with the
  older `arcface_r100` / `adaface_ir101` (unaligned) spaces; every
  reader filters on the tag.

Alignment itself is `fnvr_ml/align.py` — the 5-point Umeyama
similarity transform onto the canonical ArcFace 112×112 template. It
is the ONLY alignment implementation; live and upload paths share it,
so their embeddings agree by construction (verified ≥0.9 cosine for
the same face through both paths).

Enable / disable system-wide via `settings.detector.face_id_enabled`;
per-camera via `cameras.enabled_detectors`.

## Live flow (the async embed hop)

```
pipeline worker (InferSrcProbe, on scrfd.src):
  capture limiting (best-of-window per person-track, see pipeline.cpp
  FaceTrackState) → saveFaceCrop 256×256 JPEG →
  publish {reply_subject, detection, crop_jpeg_b64}
      → fnvr.faces.pending.<camera_id>     (JetStream FACES_PENDING,
                                            workqueue, max_age 1h)
ml-worker face_consumer:
  SCRFD on crop → centre face → align → TopoFR →
  detection.attributes += {embedding, embedding_model, norm,
                           det_score, roll, yaw}   (all strings)
  → publish bare detection to reply_subject
      (fnvr.events.detection.<cam>, or retro_… for replays — the
       pipeline stamps reply_subject from its own subject_prefix, so
       retro-replay routes itself)
event-processor: unchanged — matches + inserts like any detection.
```

Properties that fall out of this shape: an ml-worker restart delays
faces (JetStream buffers) instead of losing them; the thumb-rename at
insert time can't race the crop read (the read happens before the
republish); a crop with no detectable face republishes with
`attributes.embed_status = "no_face"` so the sighting row survives but
matcher/clusterer skip it.

## Data model

As before (`persons`, `face_embeddings`, `face_dismissals`,
`face_clusters`, `face_cluster_members` — see the migrations), with
two space-tag columns that MUST be respected by every embedding
reader:

- `face_embeddings.model` — enrolment space. All current writers set
  `'topofr_r100'`.
- `face_dismissals.model` — dismissal-negative space (added 0038; the
  negative veto compares embeddings, so it needs the tag too).

Detection rows carry `attributes.embedding_model`; the retro-matcher
and the clusterer filter on it.

## Enrolment paths

1. **Upload a photo** — `POST /api/v1/faces/upload-enrol` →
   ml-worker `/detect-and-embed` (aligned, same code as live). 409 +
   face list on multi-face images; UI picks `face_index`.
2. **Enrol a cluster** — copies member embeddings to the person.
3. **Enrol from the review queue** — single or multi-select.

All go through `persons.AddEmbedding` / `AddEmbeddingsBulk`; bulk
batches are diversity-pruned (`enrolprune.go`) so near-duplicate
samples don't fake the matcher's top-3 corroboration.

## Match algorithm

Unchanged in shape (event-processor `onDetection`, face branch):
top-3-mean cosine per person → threshold (`faces.match_threshold`,
default **0.55** in the aligned space) → runner-up margin → late
negative veto against `not_a_face`/`duplicate` dismissals (same-space
only). Retro-matching on enrol (api-server `RetroMatch`) mirrors it.

## Quality signals

Every embedded face detection carries `norm` (TopoFR pre-normalisation
feature norm), `det_score` (SCRFD), and `roll`/`yaw` proxies from the
landmark geometry. Phase 2 of the rework gates ENROLMENT eligibility
on these (matching uses everything). Note: unlike AdaFace, TopoFR's
norm has not shown a reliable positive quality correlation in our
spot-checks — prefer det_score + pose + blur until measured otherwise.

## Drift detection & clustering

As before (ml-worker `drift.py` weekly self-match, `clusters.py`
nightly HDBSCAN) — both now filter to the current embedding space.
Migration 0038 cleared the old-space drift baseline and flushed
unenrolled old-space clusters.

## Migration from the unaligned stack

Old-space enrolments cannot be compared to new-space probes. ml-worker
exposes `POST /migrate-embeddings`: re-embeds each old enrolment from
its saved source image (thumb or upload), inserting a new-tag row;
rows whose image is gone are reported for manual re-enrolment. Old
rows are kept — rollback is an image revert plus threshold 0.40.

## GDPR erasure

Unchanged: `DELETE /api/v1/persons/<id>` cascades embeddings + audit
row; matcher forgets at next reload (≤30 s).
