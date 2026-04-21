# Prometheus metrics

Two scrape targets on the compose network:

- **api-server** — `http://api:8081/metrics` (same port as the JSON API). Unauthenticated; scoped to the internal bridge by compose.
- **event-processor** — `http://events:9091/metrics`. Dedicated port so the metrics surface can be scraped without going through the main NATS-subscriber process.

## api-server surface

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `fnvr_http_requests_total` | counter | `method`, `route`, `status` | `route` = `r.Pattern` (Go 1.22 servemux), so `/api/v1/cameras/{id}` aggregates all camera ids. Unmatched requests bucketed as `"-"`. |
| `fnvr_http_request_duration_seconds` | histogram | `method`, `route` | `prometheus.DefBuckets`. |
| `fnvr_db_queries_total` | counter | `name`, `result` | Named queries only (recent-detections, faces-recent, timeline). Not auto-instrumented on every query. |

Process + Go runtime metrics come along for the ride (`go_goroutines`, `process_resident_memory_bytes`, etc.) via the default Prometheus registry.

Middleware wrapping the servemux implements `Flush()` + `Hijack()` delegates — without those, SSE (`/api/v1/events/stream`) returns `streaming unsupported`. [apps/api-server/internal/metrics/metrics.go](../../apps/api-server/internal/metrics/metrics.go).

## event-processor surface

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `fnvr_detections_processed_total` | counter | `camera_id`, `kind` | Incremented at the very top of `onDetection`. |
| `fnvr_rules_evaluated_total` | counter | `result` | `fire | skip | muted | noop`. Not wired everywhere yet — wire as rule-paths grow. |
| `fnvr_incidents_fired_total` | counter | `severity`, `rule_kind` | `rule_kind ∈ object | sequence | hotlist | face | drift`. |
| `fnvr_reload_duration_seconds` | histogram | — | Buckets tuned to `[.01, .025, .05, .1, .25, .5, 1, 2, 5]`. Engine reload normally lands in 30–70 ms. |
| `fnvr_rules_loaded` | gauge | — | Refreshed every reload. |
| `fnvr_enrolled_embeddings` | gauge | — | Ditto. |
| `fnvr_face_negatives` | gauge | — | Ditto. |

## Sample scrape config

```yaml
scrape_configs:
  - job_name: fnvr-api
    static_configs:
      - targets: ['api:8081']
  - job_name: fnvr-events
    static_configs:
      - targets: ['events:9091']
```

Both endpoints are on the internal `fnvr_default` docker bridge. For host-side scraping, expose them via compose `ports:`.

## What's NOT exposed

Things that would be nice but aren't in yet:

- **storage-manager** — no /metrics. `fnvr_segments_indexed_total`, `fnvr_segments_purged_total{reason}`, `fnvr_disk_free_bytes` would all belong here. Nice slice.
- **ml-worker** — FastAPI runs on :8090; could mount `prometheus-fastapi-instrumentator` cheaply.
- **notification-dispatcher** — delivery success/failure counts live in the DB (`notification_deliveries`) but no gauge surfaces them.
- **Pipeline** — no Prometheus endpoint on the C++ side; `tegrastats` is the operator-facing proxy. A native exporter is a larger slice.

## Alerting hooks

Useful rules to add to your Prometheus:

```yaml
groups:
- name: fnvr
  rules:
  - alert: FnvrReloadSlow
    expr: histogram_quantile(0.95, fnvr_reload_duration_seconds_bucket) > 2
    for: 5m
  - alert: FnvrNoDetections
    expr: rate(fnvr_detections_processed_total[5m]) == 0
    for: 10m
    labels: { severity: warning }
  - alert: FnvrDriftIncident
    expr: increase(fnvr_incidents_fired_total{rule_kind="drift"}[1h]) > 0
    labels: { severity: warning }
```

The "no detections" rule is the one that would have caught the silent-NATS-drop bug faster last time we hit it.
