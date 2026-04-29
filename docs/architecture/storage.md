# Storage

**Recordings are written by MediaMTX, not by the supervisor.** Each pipeline worker pushes its source elementary stream (H.264 or H.265) into the `mediamtx` sidecar via `rtspclientsink`, and MediaMTX's built-in recorder fragments it into fMP4 chunks on disk. The supervisor never touches the recording filesystem.

The storage-manager ([apps/storage-manager/internal/lifecycle/lifecycle.go](../../apps/storage-manager/internal/lifecycle/lifecycle.go)) is the only service that deletes recordings. It runs a 30 s tick with four passes:

1. **Index new segments.** Walk `/var/lib/fnvr/recordings/<camera>/YYYY-MM-DD_HH-MM-SS-NNN.mp4` (MediaMTX's default `recordPath` template) and upsert into `segments`. File size / mtime are refreshed on every tick so an open recording's row stays current.
2. **Apply retention.** Drop segments older than their camera's `retention_days`, unless `protected=TRUE`.
3. **Apply quota.** For any camera whose `SUM(bytes) > quota_gb × 1 GB`, drop oldest unprotected segments until under.
4. **Apply disk pressure.** If free disk falls below `settings.storage.min_free_pct` (default 10%), drop oldest unprotected segments across all cameras, 20 at a time, re-checking after each batch. Caps at 500 rows per tick.

Detection hot-table pruning also runs here — `settings.detections_hot_hours` (default 168 h) rows are dropped in batches so Postgres stays small. The same tick removes per-segment JSONL sidecars whose parent mp4 is gone.

## Segment layout

```
/var/lib/fnvr/recordings/
  house-back/                              # one dir per MediaMTX path == per camera
    2026-04-29_08-00-00-000.mp4            # fMP4, codec from source (h264 or h265)
    2026-04-29_09-00-00-000.mp4            # rotated by recordSegmentDuration
    ...
```

fMP4 not progressive MP4 — the `moov` is at the front and segments are seekable mid-write, which is what makes timeline scrubbing work even on a still-recording file. Codec is whatever the camera sends; we no longer transcode H.265 → H.264, since MediaMTX's `/get` endpoint streams the elementary track to the browser directly and Chrome / Firefox / Safari all handle H.265 in fragmented MP4 (with per-browser loader quirks documented in [pipeline.md](pipeline.md)).

Older layouts produced by the previous `mp4mux + filesink` path (`YYYY/MM/DD/HH/<camera>/rec.mp4`) are also recognised by the segmenter's regex — pre-MediaMTX recordings continue to be indexed and purged correctly until they age out.

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
