# Settings reference

All runtime tunables live in one Postgres table:

```sql
settings(key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)
```

Some keys have a Settings UI page; others are psql-only. The values below are the committed defaults; check `SELECT * FROM settings` for the live state. Services reload their settings automatically (api-server per request, event-processor every 30 s, storage-manager every 30 s) — no restart needed.

## Detector

| Key | Default | Range | Effect |
|---|---|---|---|
| `detector.yolo26_variant` | `"yolo26x"` | `n/s/m/l/x` | Picks the object detector ONNX. Larger = slower + more accurate. `x` on Orin at FP16 ~= 2× load of `s`. |
| `detector.yolo26_precision` | `"fp16"` | `fp16` \| `int8` | INT8 calibration is blocked on a TRT 10.3 bug (see [known-issues.md](known-issues.md)); setting it falls back to FP16 with a banner. |
| `detector.anpr_enabled` | `true` | bool | System-wide LPDNet + LPRNet kill switch. Per-camera disable via `cameras.enabled_detectors`. |
| `detector.face_id_enabled` | `true` | bool | System-wide SCRFD + ArcFace kill switch. |

Edits via the **Settings → Detector** page restart the pipeline container automatically.

## Face-ID

| Key | Default | Range | Effect |
|---|---|---|---|
| `faces.match_threshold` | `0.40` | (0,1) | Top-K mean cosine floor. Recommended 0.32 for the current matcher. |
| `faces.match_margin` | `0.05` | [0, 0.5] | Required gap between winning person's topK and runner-up's when >1 person is enrolled. Ignored for a single-person pool. |
| `faces.negative_penalty_weight` | `1.0` | [0, 2] | 0 disables negatives. Was historically set to 1.0 and found to over-suppress; a noisy negatives pool will keep tim from matching. |

See [face-id.md](face-id.md) for tuning advice.

## Storage

| Key | Default | Range | Effect |
|---|---|---|---|
| `storage.min_free_pct` | `10.0` | [0, 50] | Free-disk floor below which storage-manager purges oldest segments across all cameras. |
| `detections_hot_hours` | `168` | > 0 | Detection rows older than this are pruned from Postgres on each storage-manager tick. Per-segment sidecar JSONL preserves history for the timeline. |

## ML worker

| Key | Default | Effect |
|---|---|---|
| `ml.cluster.batch_schedule` | `"03:00"` | Local time for nightly HDBSCAN over unmatched face embeddings. |
| `ml.cluster.min_cluster_size` | `3` | HDBSCAN parameter. Smaller = more clusters + more noise. |
| `ml.cluster.last_run_state` | `null` | Populated by each run — powers the "last clustered…" label on the Clusters panel. |
| `ml.cluster.last_run_error` | `null` | Latest error string if a run failed. |
| `ml.drift.baseline_self_match` | `null` | Set by drift.py on first run. |
| `ml.drift.last_run_state` | `null` | Latest drift-check payload. Powers the drift pill. |

## Home Assistant / MQTT

See [architecture/notifications.md](../architecture/notifications.md). Settings live per-channel in `notification_channels.config`, not in the `settings` table.

## Editing from psql

```sql
-- Flip match threshold:
UPDATE settings SET value = '0.32'::jsonb WHERE key = 'faces.match_threshold';

-- Enable disk-pressure floor at 20%:
UPDATE settings SET value = '20.0'::jsonb WHERE key = 'storage.min_free_pct';

-- Seed a new key (rare):
INSERT INTO settings (key, value)
VALUES ('my.new.key', '"foo"'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

Most callers clamp values server-side, so pushing out-of-range JSON falls back to the default rather than breaking the service. Invalid JSON in a value cell will log a warning and also fall back.
