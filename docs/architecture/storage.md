# Storage

The storage-manager ([apps/storage-manager/internal/lifecycle/lifecycle.go](../../apps/storage-manager/internal/lifecycle/lifecycle.go)) is the only service that deletes recordings. It runs a 30 s tick with four passes:

1. **Index new segments.** Walk `/var/lib/fnvr/recordings/YYYY/MM/DD/HH/<camera>/rec*.mp4` and upsert into `segments`. File size / mtime are refreshed on every tick so an open recording's row stays current.
2. **Apply retention.** Drop segments older than their camera's `retention_days`, unless `protected=TRUE`.
3. **Apply quota.** For any camera whose `SUM(bytes) > quota_gb × 1 GB`, drop oldest unprotected segments until under.
4. **Apply disk pressure.** If free disk falls below `settings.storage.min_free_pct` (default 10%), drop oldest unprotected segments across all cameras, 20 at a time, re-checking after each batch. Caps at 500 rows per tick.

Detection hot-table pruning also runs here — `settings.detections_hot_hours` (default 168 h) rows are dropped in batches so Postgres stays small. The same tick removes per-segment JSONL sidecars whose parent mp4 is gone.

## Segment layout

```
/var/lib/fnvr/recordings/
  2026/04/21/08/                # YYYY/MM/DD/HH
    house-back/rec.mp4          # hourly rotation; mp4mux + filesink
    house-side/rec.mp4
    makershop/rec.mp4
```

One growing `rec.mp4` per camera per hour, H.264-encoded regardless of source codec, so the browser plays it back natively via `<video>` + Range requests. `mp4mux + filesink` writes the `moov` atom at ~1 s intervals so partial files are playable while the pipeline is still recording.

Older layouts (`seg-NNNNN.mp4`) are also recognised by the segmenter's regex — pre-hourly-rotation recordings continue to work.

## Schema

```sql
CREATE TABLE segments (
    id         BIGSERIAL PRIMARY KEY,
    camera_id  TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    path       TEXT NOT NULL UNIQUE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at   TIMESTAMPTZ,
    bytes      BIGINT,
    codec      TEXT DEFAULT 'h264',
    duration_ms INT,
    tier       TEXT DEFAULT 'hot',     -- stubbed; always 'hot' today
    protected  BOOLEAN DEFAULT FALSE
);
```

Per-camera config lives on `cameras`:
- `retention_days` — default 14; range 1–3650.
- `quota_gb` — default 200; range 1–10000.

See [operations/storage-management.md](../operations/storage-management.md) for the UI and how to tune.

## Per-segment detection sidecars

Event-processor writes a JSONL file alongside each `rec.mp4` — one line per detection — so historical detection density is preserved even after Postgres's hot-table prune runs. The timeline UI reads these directly for past days. Storage-manager removes sidecars in lockstep with their segment, so there's no orphan accumulation.

## Disk-pressure floor

Configurable via `settings.storage.min_free_pct` (0–50, default 10). Read once per tick; changing it via psql or a future Settings UI takes effect within 30 s without a restart. When engaged, an "Emergency purge active" pill shows on the Storage page's disk bar.

Why not configurable via the UI yet: the knob is a safety-net, not an operational dial; we didn't want to encourage tuning it down to "use every byte" and then having a single bad-RTSP camera fill the disk with bogus data.

## Observability

Per-camera storage state is surfaced in the UI's Storage page ([apps/web/src/routes/storage/Storage.tsx](../../apps/web/src/routes/storage/Storage.tsx)):

- bytes_used
- GB/day burn rate (bytes_used / age_days where age is from MIN(started_at))
- days-of-headroom = min(retention_days, (quota_gb − bytes_used_gb) / gb_per_day)
- oldest + newest segment timestamps
- segment count

The disk gauge reads `syscall.Statfs(FNVR_RECORDINGS_DIR)` server-side, same primitive as storage-manager's floor check, so operator view and purge logic never disagree on "how much free disk".

## What's not yet implemented

- **Tiering** (hot → warm → cold): `segments.tier` column exists but every row lands as `hot`. Post-v1, this lets you retain last-7-days at full res + last-90-days at keyframe-only + last-365-days as events-only.
- **Event-locked segments**: no FK from `incidents` → `segments`, so purge doesn't know "don't delete this one, it has an unacknowledged incident". Slice would add that column + a predicate in `applyRetention`.
- **SMART polling / disk health**.
- **Evidentiary export bundles** with SHA-256 chain-of-custody.

All three live in PLAN.md §5. Current slice is deliberately minimal.
