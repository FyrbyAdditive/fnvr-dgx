# Face-ID

Face identification is a three-stage chain: detect → embed → match. Detect and embed run inside the pipeline; matching runs in the event-processor after the detection is published. Enrolments and dismissals live in Postgres.

## Models

Bundled under `/var/lib/fnvr/models/faceid/`:

- **SCRFD** (`face_detector.onnx`) — anchor-free detector, outputs box + 5-point landmarks per face. ~480×640 input, FP16 engine.
- **ArcFace R100** (`arcface.onnx`) — 112×112 aligned-face input, outputs a 512-d L2-normalised embedding. FP16 engine.

Both run as `nvinfer` SGIEs chained off the pipeline's primary detector. See [architecture/pipeline.md](pipeline.md) for how they slot in.

Enable / disable system-wide via `settings.detector.face_id_enabled`; per-camera via `cameras.enabled_detectors`.

## Data model

```sql
-- The person who "owns" a set of embeddings.
CREATE TABLE persons (
    id UUID PK, label TEXT, enabled BOOL,
    alert_on_match BOOL,
    created_at, updated_at
);

-- Raw 512-d enrolment vectors (pgvector).
CREATE TABLE face_embeddings (
    id UUID PK,
    person_id UUID FK ON DELETE CASCADE,
    embedding VECTOR(512),
    source TEXT,            -- 'upload-<sha>', 'cluster-<short>-<did>',
                            -- 'enrol-live-<did>', 'enrol-cluster-<did>', ...
    detection_id BIGINT,    -- links back to a detection for thumbnail lookup
    created_at TIMESTAMPTZ
);
CREATE INDEX … ivfflat (embedding vector_cosine_ops) WITH (lists=100);

-- Flagged negatives. Only 'not_a_face' and 'duplicate' feed the matcher's
-- negative-penalty; 'deleted' and 'enrolled' are UI-only hides.
CREATE TABLE face_dismissals (
    detection_id TEXT PK, embedding VECTOR(512), reason TEXT, created_at
);

-- HDBSCAN cluster centroids + members.
CREATE TABLE face_clusters (
    id UUID PK, centroid VECTOR(512), member_count INT,
    representative_detection_id BIGINT,
    algorithm TEXT, enrolled_person_id UUID
);
CREATE TABLE face_cluster_members (
    cluster_id UUID FK ON DELETE CASCADE,
    detection_id BIGINT,
    embedding VECTOR(512),       -- duplicated here so enrol + dismiss are one SQL step
    similarity_to_centroid REAL,
    added_at
);
```

## Enrolment paths

1. **Upload a photo** (Faces page → *Upload photo to enrol*). Multipart POST hits `POST /api/v1/faces/upload-enrol`, the api-server hands bytes to ml-worker's `/detect-and-embed`. On a single-face image the embedding is inserted immediately with `source="upload-<sha256[:8]>"`. On a multi-face image the server replies 409 + the face list; the UI lets the operator pick and POSTs again with `face_index`.
2. **Enrol a cluster** (Faces page → Clusters panel → *enrol*). Reads every `face_cluster_members.embedding` for the cluster and inserts each with `source="cluster-<short>-<detection_id>"`.
3. **Enrol from a live match** (Faces page → Recent faces → "this is tim"). Inserts a single embedding with `source="enrol-live-<detection_id>"`.

All three write-paths go through `persons.AddEmbedding` / `AddEmbeddingsBulk`. Embeddings are NOT re-normalised before insert — we trust the ml-worker / pipeline to return unit vectors (which they do, consistently).

## Match algorithm

[engine.go](../../apps/event-processor/internal/rules/engine.go) `onDetection`, face branch:

```
For each face detection with attributes.embedding:
  probe = L2-normalise(base64decode(embedding))
  Group faceEnrolments by person_id, computing cos(probe, each).
  For each person:
    sims = sorted desc
    topK = mean of sims[:min(3, len(sims))]
  winner = argmax(topK)
  accept if topK[winner] >= faces.match_threshold
         AND (len(persons)==1 OR topK[winner] - topK[runner-up] >= faces.match_margin)
  If accept AND faces.negative_penalty_weight > 0:
    maxNeg = max cos(probe, each face_dismissal with reason∈{not_a_face, duplicate})
    if topK[winner] - weight × maxNeg < threshold: retract
  On accept: attributes.person, .person_id, .similarity get set on the detection row.
```

Why top-K mean and not best-of-N: best-of-N lets a single rogue (e.g. upload-picked-wrong-face) enrolment match anything close to that specific noise. Top-K requires a probe to look like *several* of the person's embeddings, so a genuinely-you probe with 3 similar siblings in the pool fires; a probe that happens to match one outlier enrolment doesn't.

## Quality of enrolments

The per-person drill-down on the Faces page shows each embedding's **nearest-neighbour similarity** — the mean cosine to its 3 closest siblings in the same pool. Outliers (wrong-person enrolments, heavy noise) score low regardless of pool size; legitimate pose/lighting variants stay high as long as a few similar siblings exist.

This is different from a whole-pool mean (which we used briefly and got wrong — it penalises diversity). The kNN metric is robust to diversity.

Colour thresholds: red < 0.35, amber 0.35–0.50, green ≥ 0.50. See [operations/face-id.md](../operations/face-id.md) for how to use the badge.

## Drift detection

ml-worker runs a weekly self-match check ([apps/ml-worker/fnvr_ml/drift.py](../../apps/ml-worker/fnvr_ml/drift.py)):

1. For each person with ≥2 embeddings, compute the mean pairwise cosine between their own embeddings.
2. Average across persons → `current_self_match`.
3. First ever run stores this as baseline in `settings.ml.drift.baseline_self_match`.
4. Subsequent runs compare. If `baseline − current ≥ 0.05`, publish `fnvr.alerts.drift` with `{at, baseline, current, delta}`.
5. Every run writes a `last_run_state` into settings so the UI drift pill can show "last checked Nd ago".

The event-processor turns the alert into a system-scope incident (see [rules-engine.md](rules-engine.md#drift-alerts)) which the notification-dispatcher fans out.

## Clustering

Nightly (configurable via `settings.ml.cluster.batch_schedule`, default 03:00), ml-worker's HDBSCAN pass:

1. Pulls every face detection embedding from the last 7 days whose match `similarity` is below the enrolment threshold.
2. Runs HDBSCAN with `min_cluster_size = settings.ml.cluster.min_cluster_size` (default 3).
3. For each resulting cluster, computes the L2-normalised centroid, finds the highest-confidence representative detection, writes rows to `face_clusters` + `face_cluster_members`.
4. On overlap with an existing not-yet-enrolled cluster (centroid cosine ≥ 0.6), merges rather than duplicating.

The UI surfaces unenrolled clusters; operator either enrols (copying embeddings to a person) or dismisses (plain delete) or dismisses-as-not-a-face (writes each member to `face_dismissals(reason='not_a_face')` before deletion, training the negative-penalty pool against this cluster in future).

## GDPR erasure

`DELETE /api/v1/persons/<id>` cascades `face_embeddings`, writes a `persons_erasure_audit` row, and (slice 1) does not scrub historical detection rows. The embeddings are gone from the matcher at next reload (≤30 s); historical detections still carry the person's name in their `attributes.person` column. A future slice adds redaction of those.
