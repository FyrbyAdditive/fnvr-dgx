# ml-worker

Python FastAPI sidecar on port `:8090`. Owns the face-ID CPU path (detect + embed for upload-photo enrolment), nightly HDBSCAN clustering over unmatched face embeddings, and the weekly self-match drift check.

Full face-ID flow in [docs/architecture/face-id.md](../../docs/architecture/face-id.md); operator guide in [docs/operations/face-id.md](../../docs/operations/face-id.md).

## Modules

- `app.py` — FastAPI surface: `/health`, `/embed`, `/detect-and-embed`, `/cluster`, `/drift/run`.
- `inference.py` — CPU onnxruntime wrapper for SCRFD (detector) + ArcFace (embedder).
- `clusters.py` — HDBSCAN over the last week's unmatched face embeddings → `face_clusters` + `face_cluster_members`.
- `drift.py` — per-person mean pairwise cosine self-match, publishes `fnvr.alerts.drift` on ≥ 5 % drop. Writes `settings.ml.drift.last_run_state` every run.
- `scheduler.py` — APScheduler wiring for nightly cluster + weekly drift.
- `tao_stub.py` — scaffold for TAO fine-tune + shadow-mode promotion. Not wired.

## Deferred: TAO fine-tune

The training loop is scaffolded but not running. Resuming needs a training box (not the Orin — JetPack 6.2 ships inference-only TRT). When that lands, hook `tao_stub.py` into an `nvcr.io/nvidia/tao` container job and populate the `fine_tune_jobs` state machine. All the downstream pieces (shadow metrics column, NATS `fnvr.models.faceid.reload` subject, `promote_model()` atomic swap) are already in place.
