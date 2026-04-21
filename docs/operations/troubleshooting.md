# Troubleshooting

Mined from real incidents we've hit. Go to the symptom that matches; each one has the actual fix, not a guess.

## Pipeline "offline" but the video is fine

**Symptom.** Live tiles show the video but with a "pipeline offline · last heartbeat 12m ago" badge overlaid. Recordings keep growing. Detections keep flowing.

**Cause.** The pipeline's NATS client auto-reconnect gave up (default 60 attempts / ~2 min). `natsConnection_Publish` returns OK from the client-side queue but the messages are dropped — including the 30-s `fnvr.state.camera.<id>` heartbeats. The api-server's 10-min TTL then expires to `unknown`, showing the badge.

**Fix (already shipped).** The NatsPublisher wraps the client with unlimited reconnects + explicit CLOSED-state detection + auto-rebuild. If you're still on an old build, `docker compose pull && docker compose up -d pipeline` picks up the fix.

**Immediate unblock if you can't rebuild right now.** Manually republish the running state:

```bash
sudo docker exec fnvr-ml-worker-1 python3 -c "
import asyncio, os, json, nats
async def main():
    nc = await nats.connect(os.environ['FNVR_NATS_URL'])
    for cam in ('makershop','house-side','house-back'):   # your cam ids
        await nc.publish(f'fnvr.state.camera.{cam}',
                         json.dumps({'camera_id': cam, 'state': 'running'}).encode())
    await nc.flush(); await nc.drain()
asyncio.run(main())"
```

## Live view + Events SSE both blank

**Symptom.** Live tiles stay on "No recording yet"; Events page shows "Listening on SSE…" and never gets anything.

**Causes we've hit:**

1. **Middleware swallowing `http.Flusher`.** Any middleware wrapping the SSE handler in a `statusRecorder` must implement `Flush()` or the SSE handler bails with "streaming unsupported". Our Prometheus middleware hit this; fixed by adding Flush + Hijack delegates. If your build's api-server log shows `streaming unsupported`, pull an up-to-date image.
2. **Pipeline genuinely not publishing detections.** Use the Storage page to confirm `rec.mp4` is still growing; if it is but detection rows aren't landing, check the pipeline log for `keyframe gate: opened` followed by silence — that's our other smoking gun. Usually fixed by restarting the pipeline container.
3. **Cookie session expired.** The SSE endpoint is gated on session cookie; browser sessions time out at 24 h. Reload the page.

Distinguish: `curl -sN http://<orin>:8081/api/v1/events/stream --cookie fnvr_session=<...>` for 20 s should at minimum print a `: ping` keep-alive line. If it doesn't, middleware is broken; if it does but you still see nothing, no detections are flowing.

## Face matches stopped working entirely

See [face-id.md § common problems](face-id.md#common-problems--diagnosis). The quick triage:

```sql
SELECT value FROM settings WHERE key IN (
  'faces.match_threshold',
  'faces.match_margin',
  'faces.negative_penalty_weight'
);
SELECT reason, COUNT(*) FROM face_dismissals GROUP BY reason;
SELECT COUNT(*) FROM face_embeddings fe JOIN persons p ON p.id=fe.person_id
 WHERE p.label='tim';
```

- Threshold > 0.40 AND penalty weight > 0 AND negatives > 100 → almost certainly the neg-penalty is destroying the score. Fix: set weight to 0, wipe negatives.
- Threshold = 0.40 and no obvious cause → drop to 0.32 for the top-K matcher.
- Embedding count < 10 → pool is too thin. Enrol clusters.

## INT8 YOLO calibration fails

Blocked upstream. See [known-issues.md](known-issues.md).

Current behaviour: the entrypoint tries offline calibration, hits the `checkLinks::218` TRT assertion, catches it, reports to api-server, flips precision to FP16 in-memory, renders the FP16 config, continues. You'll see a red banner in Settings. Stack stays up on FP16.

## "Pipeline failed" banner on a specific camera

Per-camera pipeline worker exited with non-zero. Check:

```bash
sudo docker logs fnvr-pipeline-1 --tail 200 2>&1 | grep -E "worker\[<cam-id>\]|error"
```

Common triggers:
- **RTSP URL wrong / unauthenticated.** You'll see "Could not read from resource" from gstreamer. Fix the URL in Settings → Cameras.
- **Camera's stream format unsupported.** ffprobe handshake rejected a codec we don't recognise. Only H.264 and H.265 are tested.
- **TRT engine file corrupt.** Delete `/var/lib/fnvr/models/yolo26/*.engine` inside the container; let it rebuild on next start.

The supervisor restarts a crashed worker with exponential backoff; a single flaky camera won't take the stack down. But if a worker exits many times per minute, the backoff grows and the camera effectively stays offline — that's what the "pipeline failed" badge indicates.

## Recordings aren't showing in the Timeline

1. **Is storage-manager running?** `sudo docker logs fnvr-storage-1 --tail 20`. It should log indexing activity every tick.
2. **Is the file actually on disk?** `sudo docker exec fnvr-pipeline-1 ls -lt /var/lib/fnvr/recordings/$(date -u +%Y/%m/%d/%H)/*/`.
3. **Did the segment get indexed?** `SELECT camera_id, COUNT(*), MAX(ended_at) FROM segments GROUP BY camera_id;`. If `ended_at` is many minutes old, storage-manager isn't running or is backlogged.
4. **Does the timeline's date filter match?** The page defaults to "today in local time"; if your server clock is off, you'll look in the wrong slot. Check `timedatectl`.

## Disk filling faster than expected

Open **Storage**; the GB/day column tells you who. Common causes in order:

- **Camera bitrate too high.** 1080p at 8 Mbps is ~86 GB/day. Drop bitrate at the camera, not here.
- **30 fps recording on a camera where 10 fps is enough.** Same fix — camera-side.
- **Quota too loose.** Cap `quota_gb` on the heavy camera; it'll auto-purge.

Don't lower `storage.min_free_pct` as a "let me use more disk" dial — it's a safety net.

## Clean reset of Face-ID

Only nuclear option — loses all enrolments + dismissals + clusters. Useful if the pool is so compromised you'd rather start over.

```sql
BEGIN;
DELETE FROM face_cluster_members;
DELETE FROM face_clusters;
DELETE FROM face_dismissals;
DELETE FROM face_embeddings;
DELETE FROM persons;
UPDATE settings SET value = 'null'::jsonb
 WHERE key IN ('ml.drift.baseline_self_match', 'ml.drift.last_run_state');
COMMIT;
```

Pipeline + matcher pick up the empty pool on the next 30 s reload.
