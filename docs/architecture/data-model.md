# Data model + wire format

A condensed reference. The source of truth is [apps/api-server/internal/db/migrations/](../../apps/api-server/internal/db/migrations/) (goose, applied automatically on api-server start).

## Key Postgres tables

| Table | Purpose | Key foreign keys |
|---|---|---|
| `cameras` | Camera config (url, retention_days, quota_gb, enabled_detectors, location_kind, mute_classes_override). | — |
| `zones` | Per-camera polygon / line / tripwire geometry + per-zone class/kind mutes. | `camera_id` → `cameras` |
| `rules` | JSONB `definition` stores both single-camera + sequence rule shapes. | — |
| `incidents` | Rule / hotlist / face / drift hits. `camera_id` and `rule_id` both nullable. | soft FK to `rules`, `cameras` (ON DELETE CASCADE) |
| `detections` | Every per-frame hit; `kind ∈ object/anpr/face`. `attributes` JSONB carries plate/person/similarity/embedding. | `camera_id` → `cameras` |
| `segments` | Hourly `rec.mp4` index with bytes/duration/protected/tier. | `camera_id` → `cameras` |
| `persons` | Enrolled face identities. | — |
| `face_embeddings` | 512-d pgvector rows with `source` + optional `detection_id`. | `person_id` → `persons` |
| `face_dismissals` | Flagged negatives; `reason ∈ not_a_face, duplicate, deleted, enrolled`. Only the first two feed the matcher's negative-penalty. | — |
| `face_clusters` + `face_cluster_members` | HDBSCAN output from ml-worker. | — |
| `plate_hotlist` | LIKE-pattern plate watchlist with per-row severity + label. | — |
| `notification_channels` + `notification_subscriptions` + `notification_deliveries` | Fan-out config + audit. | — |
| `users` + `user_tokens` | Local auth (admin / viewer). | — |
| `settings` | Key/value JSONB store for tunables. | — |
| `persons_erasure_audit` | GDPR-erasure record. | — |
| `fine_tune_jobs` | Reserved for the TAO training loop (not yet populated). | — |

The migrations are append-only and numbered 0001–0023+. Never rewrite a committed migration.

## NATS subjects

Detections + incidents + system state move on NATS; jobs + heartbeats live in specific JetStream streams. See [developer/nats-subjects.md](../developer/nats-subjects.md) for the full table. The essentials:

| Subject | Producer | Consumer | Payload |
|---|---|---|---|
| `fnvr.events.detection.<camera_id>` | pipeline | event-processor, api-server SSE | per-frame detection (class/bbox/confidence/kind/attributes). |
| `fnvr.events.incident.<camera_id>` | event-processor | notification-dispatcher | incident (id, rule_id, camera_id, severity, summary, …). |
| `fnvr.events.incident.__system` | event-processor | notification-dispatcher | system-scope incident (drift alert). |
| `fnvr.state.camera.<camera_id>` | pipeline | api-server (JetStream last-value) | `{camera_id, state}` — `starting` / `running` / `failed`. |
| `fnvr.state.pipeline` | pipeline-supervisor | api-server | `{state}` — parent-process level. |
| `fnvr.alerts.drift` | ml-worker | event-processor | `{at, baseline, current, delta}`. |
| `fnvr.models.faceid.reload` | ml-worker | pipeline | Empty; tells pipeline to re-read `arcface.onnx`. |
| `fnvr.whep.registry` | pipeline | api-server | `{camera_id, port}` on WHEP server bind. |

## Prometheus metrics

api-server exposes `/metrics` on the main :8081 port (unauthenticated). event-processor on a dedicated :9091.

api-server:
- `fnvr_http_requests_total{method, route, status}` — route label comes from `r.Pattern`.
- `fnvr_http_request_duration_seconds_bucket{method, route, le}`.
- `fnvr_db_queries_total{name, result}` — named queries (recent-detections, faces-recent, timeline).

event-processor:
- `fnvr_detections_processed_total{camera_id, kind}`.
- `fnvr_rules_evaluated_total{result}` — fire / skip / muted / noop.
- `fnvr_incidents_fired_total{severity, rule_kind}` — `rule_kind ∈ object, sequence, hotlist, face, drift`.
- `fnvr_reload_duration_seconds` histogram.
- `fnvr_rules_loaded`, `fnvr_enrolled_embeddings`, `fnvr_face_negatives` gauges.

See [developer/metrics.md](../developer/metrics.md) for scraping advice.

## Settings keys

See [operations/settings.md](../operations/settings.md) for the full reference. Highlights:

| Key | Default | Purpose |
|---|---|---|
| `detector.yolo26_variant` | `"yolo26x"` | `yolo26n/s/m/l/x`. Larger = slower + more accurate. |
| `detector.yolo26_precision` | `"fp16"` | `fp16` or `int8`. INT8 is blocked on a TRT bug ([known issues](../operations/known-issues.md)). |
| `detector.anpr_enabled` | `true` | System-wide kill switch for the ANPR SGIEs. |
| `detector.face_id_enabled` | `true` | System-wide kill switch for the SCRFD + ArcFace SGIEs. |
| `faces.match_threshold` | `0.40` | Top-K mean floor. 0.32 recommended with the current matcher. |
| `faces.match_margin` | `0.05` | Required gap between winner and runner-up when >1 person is enrolled. |
| `faces.negative_penalty_weight` | `1.0` | 0 disables negatives. |
| `storage.min_free_pct` | `10.0` | Emergency-purge floor. |
| `ml.cluster.batch_schedule` | `"03:00"` | Local time for nightly HDBSCAN. |
| `ml.cluster.min_cluster_size` | `3` | HDBSCAN parameter. |
| `ml.drift.baseline_self_match` | `null` | Set by drift.py on first run. |
| `ml.drift.last_run_state` | `null` | Last check payload — powers the drift pill. |
| `detections_hot_hours` | `168` | Age at which old detection rows get pruned from Postgres. |
