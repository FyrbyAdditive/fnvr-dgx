# storage-manager

Go service. Indexes `rec.mp4` segments into `segments`, enforces per-camera `retention_days` + `quota_gb`, and runs a configurable disk-pressure emergency purge. Also prunes the `detections` hot-table + matching per-segment JSONL sidecars in lockstep.

Design in [docs/architecture/storage.md](../../docs/architecture/storage.md); operator guide + UI in [docs/operations/storage-management.md](../../docs/operations/storage-management.md).

## Not yet implemented

- Tiering (`tier` column always `hot`).
- Event-locked segments (no FK into incidents).
- SMART polling.
- Evidentiary export bundles with SHA-256 chain-of-custody.

See [docs/architecture/storage.md § what's not yet implemented](../../docs/architecture/storage.md#whats-not-yet-implemented).
