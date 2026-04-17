# ml-worker

Python worker for the training / active-learning loop:

- TensorRT engine conversion (`.onnx` / TAO `.etlt` → `.engine`, per JetPack version and precision).
- Hard-negative mining from user-labelled false positives.
- Nightly fine-tune jobs via TAO Toolkit (transfer-learning from bundled checkpoints).
- Drift detection on a held-out golden set.
- Face embedding cluster + enrollment assist ("this unidentified face appears in 47 clips").
- Semantic search indexing (CLIP embeddings into pgvector).

Consumes jobs from NATS (`fnvr.jobs.ml.*`) and writes results back via REST to `api-server`.

Lands in M4. M1 stub only — `fnvr_ml/__init__.py` present so imports don't explode.
