# Storage management

The **Storage** page (sidebar nav) is the operator's view of disk health and per-camera usage. Read-only for viewers; admin gets per-row retention + quota editors.

## What it shows

```
Storage
━━━━━━━━
Disk: 420 GB free of 2.0 TB (21%)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░
Emergency purge floor: 10%

Per-camera usage
┌──────────────────┬──────────┬──────┬──────┬──────┬─────┬──────┐
│ Camera           │ Used     │ Days │ GB/d │ Quota│ Ret.│      │
├──────────────────┼──────────┼──────┼──────┼──────┼─────┼──────┤
│ House back       │ 137 GB   │ 14.0 │ 9.8  │ 200  │ 14  │ edit │
│ House side       │ 128 GB   │ 13.2 │ 9.7  │ 200  │ 14  │ edit │
│ Driveway         │ 44 GB    │  8.1 │ 5.4  │ 100  │ 14  │ edit │
└──────────────────┴──────────┴──────┴──────┴──────┴─────┴──────┘
```

- **Disk bar.** Blue until free disk dips below `storage.min_free_pct`, then red with an "Emergency purge active" pill. The amber vertical line marks the purge floor.
- **Days.** Headroom = `min(retention_days, (quota_gb − bytes_used_gb) / gb_per_day)`. Amber when quota will truncate retention (you'll hit the quota before the retention policy does the work). Red when used ≥ 95 % of quota — purge is imminent for that camera.
- **Edit.** Inline editor for `retention_days` (1–3650) + `quota_gb` (1–10000). Saves hit `PATCH /api/v1/cameras/{id}/storage`.

The page refetches every 15 s so GB/day and days-of-headroom stay fresh.

## Behaviour

- **Retention.** Segments older than a camera's `retention_days` are deleted on every 30 s storage-manager tick.
- **Quota.** Oldest unprotected segments are dropped until the camera is back under `quota_gb × 1 GB`.
- **Emergency purge.** If free disk drops below `storage.min_free_pct`, oldest unprotected segments are dropped **across all cameras**, 20 at a time, until back above floor. Intended as a safety net, not an ongoing operational dial.

All three policies skip segments where `segments.protected = TRUE`. (Protected is API-only for now — `UPDATE segments SET protected=TRUE` via psql, or a future Evidence export flow will set it automatically.)

## Tuning advice

- **Retention too aggressive?** Bump `retention_days` on the Storage page. Don't fight quota by raising it above what's physically possible — disk-pressure will still evict the oldest segments.
- **Camera burning too much disk?** A busy camera with 30 fps / 8 Mbps is ~86 GB/day. Reduce bitrate at the camera, or lower the camera's `retention_days`, or cap its `quota_gb`. The system won't (yet) do bitrate tuning for you.
- **Disk getting full system-wide?** Raise `storage.min_free_pct` to give more headroom *before* emergency purge engages. Don't lower it to "use every byte" — a single bad-RTSP camera reconnect storm can fill the gap between emergency floor and full before the next tick.

## Related psql

```sql
-- What is every camera using right now?
SELECT c.id, c.name, c.retention_days, c.quota_gb,
       pg_size_pretty(SUM(s.bytes)) AS used,
       MIN(s.started_at) AS oldest,
       MAX(s.ended_at)   AS newest
FROM cameras c
LEFT JOIN segments s ON s.camera_id = c.id
GROUP BY c.id ORDER BY SUM(s.bytes) DESC NULLS LAST;

-- Protect a specific segment (bypass auto-purge):
UPDATE segments SET protected = TRUE WHERE id = 12345;

-- Drop the emergency floor (needs a reason — default 10 is usually right):
UPDATE settings SET value = '25.0'::jsonb WHERE key = 'storage.min_free_pct';
```

## What isn't implemented

See [architecture/storage.md § what's not yet implemented](../architecture/storage.md#whats-not-yet-implemented): tiering, event-locked segments, SMART polling, evidentiary export. All PLAN.md items; none blocking current operations.
