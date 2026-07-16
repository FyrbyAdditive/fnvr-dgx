# PostgreSQL tuning

fnvr uses postgres for detections, segments, incidents, settings, and
face embeddings (via pgvector). The default `pgvector/pgvector:pg18`
image ships stock postgres defaults, which assume a small VM and leave
most of a DGX-Spark-class host on the table. We override those defaults in
[deploy/docker/docker-compose.yml](../../deploy/docker/docker-compose.yml)
via `command:` flags so the deployment is self-contained — no separate
`postgresql.conf` to mount and version.

## Target host shape

The defaults below target the **NVIDIA DGX Spark (GB10: 128 GB coherent
unified LPDDR5x, NVMe)**. The critical shape difference from a normal
128 GB server: the memory pool is SHARED with the GPU — TensorRT
engines, decode surfaces and inference activations all come out of the
same 128 GB, and the platform plan reserves **≥80 GB for GPU-side use**
at the 16-camera design point. Postgres therefore gets a
generous-but-bounded slice (16 GB shared_buffers), NOT the classic
25%-of-RAM. fnvr's postgres workload is:

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
| `shared_buffers` | `16GB` | Keeps weeks of hot detection / segment / settings rows resident. Bounded well below the classic 25% because the GPU shares the pool. |
| `effective_cache_size` | `64GB` | Planner hint (not a reservation): with recordings on NVMe and the GPU idle-ish, the OS page cache can genuinely reach this. |
| `work_mem` | `64MB` | JSONB scans, ORDER BY, and pgvector searches all benefit. Per-sort, per-hash — 72 pooled conns × spikes still fit comfortably in the slice. |
| `maintenance_work_mem` | `2GB` | VACUUM, CREATE INDEX, and ANALYZE all use this. RF-DETR-era detection volume (~40 inserts/s sustained) makes fast VACUUM matter. |
| `random_page_cost` | `1.1` | NVMe random I/O is essentially as cheap as sequential. The default 4.0 came from spinning rust and biases the planner against indexes. |
| `effective_io_concurrency` | `200` | NVMe handles deep queues. Lets the planner issue many parallel reads for bitmap scans. |
| `max_wal_size` | `16GB` | Retention DELETEs generate a lot of WAL. Larger ceiling = fewer forced checkpoints during purges. |
| `min_wal_size` | `2GB` | Avoid recycling WAL too aggressively. |
| `checkpoint_completion_target` | `0.9` | Spread checkpoint I/O over 90% of the interval rather than spiking. |
| `default_statistics_target` | `200` | We run JSONB queries with `->>` operators where the planner needs accurate selectivity estimates. 200 is double the default, well worth the slightly slower ANALYZE. |
| `max_parallel_workers_per_gather` | `4` | 20 Grace cores; timeline range scans and pgvector rebuilds parallelise well without starving the pipeline processes. |

If you deploy fnvr on a smaller host, halve `shared_buffers` and
`effective_cache_size` (repeatedly, until they fit) and drop `work_mem`
to 16 MB. If GPU memory pressure appears at high camera counts
(engine build failures, `cudaErrorMemoryAllocation`), shrink
`shared_buffers` first — on unified memory postgres and the GPU
compete directly.

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
`shared_buffers` reports in 8KB pages, so 16GB shows as `2097152`).

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
