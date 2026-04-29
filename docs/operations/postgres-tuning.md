# PostgreSQL tuning

fnvr uses postgres for detections, segments, incidents, settings, and
face embeddings (via pgvector). The default `pgvector/pgvector:pg16`
image ships stock postgres defaults, which assume a small VM and leave
most of an Orin-class host on the table. We override those defaults in
[deploy/docker/docker-compose.yml](../../deploy/docker/docker-compose.yml)
via `command:` flags so the deployment is self-contained — no separate
`postgresql.conf` to mount and version.

## Target host shape

The defaults below target an **NVIDIA Jetson AGX Orin (32 GB RAM, NVMe)**
or any similar single-host deployment. fnvr's postgres workload is:

- High-volume detection inserts from `event-processor` (a few hundred per
  second when several cameras are busy).
- JSONB-heavy reads for the timeline, incidents, and flags pages.
- Time-range scans on `detections.ts` and `segments.started_at`.
- Periodic batch DELETEs from `storage-manager` for retention.
- pgvector cosine-similarity searches for face matches.

It is **not** OLTP-shaped — we don't need 100s of tiny in-flight
transactions. We do benefit from a large shared buffer cache (most rows
live in a 24-hour hot window) and from generous WAL sizing so retention
purges don't checkpoint thrash.

## Server config (compose flags)

| Flag | Value | Why |
|---|---|---|
| `shared_buffers` | `2GB` | Stock 128MB is laughable on 32GB RAM. 2GB keeps the hot detection / segment / settings rows resident. |
| `effective_cache_size` | `8GB` | Tells the planner roughly how much OS page cache is available. The Orin runs other services, so 8GB (¼ of RAM) is a safe planner hint, not a reservation. |
| `work_mem` | `32MB` | JSONB scans, ORDER BY, and pgvector searches all benefit. Per-sort, per-hash — set per-connection so 32 conns × multiple sorts can still spike, but rarely. |
| `maintenance_work_mem` | `512MB` | VACUUM, CREATE INDEX, and ANALYZE all use this. Bigger = faster maintenance windows. |
| `random_page_cost` | `1.1` | NVMe random I/O is essentially as cheap as sequential. The default 4.0 came from spinning rust and biases the planner against indexes. |
| `effective_io_concurrency` | `200` | NVMe handles deep queues. Lets the planner issue many parallel reads for bitmap scans. |
| `max_wal_size` | `4GB` | Retention DELETEs generate a lot of WAL. Larger ceiling = fewer forced checkpoints during purges. |
| `min_wal_size` | `1GB` | Avoid recycling WAL too aggressively. |
| `checkpoint_completion_target` | `0.9` | Spread checkpoint I/O over 90% of the interval rather than spiking. |
| `default_statistics_target` | `200` | We run JSONB queries with `->>` operators where the planner needs accurate selectivity estimates. 200 is double the default, well worth the slightly slower ANALYZE. |

If you deploy fnvr on a smaller host (e.g. an Orin Nano with 8 GB RAM,
or a workstation with limited RAM headroom), halve `shared_buffers` and
`effective_cache_size` and drop `work_mem` to 16 MB.

## Client (pgxpool) sizing

Each Go service initialises its own pgxpool. pgx's stock default is
`MaxConns=4`, which is far too low for a multi-service deployment.
Per-service caps:

| Service | MaxConns | MinConns | Reason |
|---|---|---|---|
| `api-server` | 32 | 2 | Highest fan-out: HTTP handlers + SSE + websockets all share. |
| `event-processor` | 16 | 1 | Detection insert + rule evaluator. |
| `storage-manager` | 16 | 1 | Retention loops, can run wide DELETEs. |
| `notification-dispatcher` | 8 | 1 | Lookup-only, low traffic. |

These are set in each service's `db.Open` / `lifecycle.New` /
`engine.go` / `dispatcher.go` (search for `cfg.MaxConns`). Total cap:
**72 connections**, well under postgres' default `max_connections=100`,
so we never starve.

The C++ pipeline-supervisor talks to postgres via libpq for camera
reconciliation only and does not pool — connections are short-lived and
infrequent. If reconciliation rate climbs, that's a future tuning
target.

## Verifying the settings are live

After bringing up the stack:

```bash
sudo docker exec fnvr-postgres-1 \
  psql -U fnvr -d fnvr -c \
  "SELECT name, setting, unit FROM pg_settings
     WHERE name IN ('shared_buffers','work_mem','max_wal_size',
                    'random_page_cost','effective_io_concurrency')
     ORDER BY name;"
```

Expected `setting` values reflect the compose flags above (note that
`shared_buffers` reports in 8KB pages, so 2GB shows as `262144`).

## When to revisit

Re-tune if any of these are observed:

- `pg_stat_database.blks_hit / (blks_hit + blks_read)` drops below ~95%
  → bump `shared_buffers`.
- Retention purges block UI queries → check `pg_stat_activity` for
  `wait_event = BufferPin` or lock waits, consider partitioning
  `detections` and `segments` by week.
- Long-running ANALYZE delays plan recovery after a schema change →
  bump `maintenance_work_mem`.
- pgvector face-match latency creeps up → investigate `ivfflat.lists`
  on `face_embeddings` (a separate tuning, not in this doc).
