# Upgrades

## Day-to-day

Single command, zero downtime for the web / API layer; pipeline restarts once.

```bash
cd ~/fnvr
git pull                              # or git fetch && git checkout <tag>
cd deploy/docker

# Without Hailo:
sudo docker compose pull
sudo docker compose up -d

# With Hailo: ALWAYS include the overlay or the pipeline loses /var/run/fnvr/hailo.sock.
sudo docker compose -f docker-compose.yml -f docker-compose.hailo.yml pull
sudo docker compose -f docker-compose.yml -f docker-compose.hailo.yml up -d
```

What happens:

- api-server starts first, runs goose migrations forward to the latest number in `apps/api-server/internal/db/migrations/`.
- event-processor + storage-manager + notification-dispatcher restart; they have no DB schema state beyond reading `settings`.
- pipeline restarts — TRT engines are cached in `/var/lib/fnvr/models/<model>/*.engine` and reload in seconds unless the engine file is missing (then it's a one-off 5–30 s compile).
- ml-worker restarts; the weekly drift + nightly clustering schedules resume.

There is no downgrade path once migrations have run. If you need to roll back, restore the Postgres backup from before the upgrade.

## If the upgrade introduces a migration

Migrations are additive and numbered. Recent ones:

- **0022** — `storage.min_free_pct` seeded.
- **0023** — `incidents.camera_id` dropped NOT NULL (system-scope incidents).

Applying is automatic on api-server start.

## Postgres config changes

When `docker-compose.yml` changes the `postgres` service's `command:`
flags (tuning knobs documented in [postgres-tuning.md](postgres-tuning.md)),
`docker compose up -d` recreates the container, which means a brief
postgres restart. api-server / event-processor / storage-manager all
reconnect automatically through their pgxpool. Plan for ~5 seconds of
"db: connect failed" log noise; nothing else needs your attention. If one fails, api-server exits non-zero; compose will try to restart, fail again, and you'll see the error in the logs. Don't force it — look at the log, fix whatever the migration found (usually a data assumption that doesn't hold on that install), then retry.

Rollback: goose can go down one step via `goose -dir … down`, but the rollbacks are only known-safe for clean data. The `Down` block in migration 0023, for instance, fails if any `incidents` row has a NULL `camera_id` — intentional, so we don't silently lose system-scope incidents on downgrade.

## Pipeline container upgrades

Pipeline rebuilds hit you harder than the others because:

- The C++ binary is rebuilt in the image, which takes a couple of minutes.
- First start after an upgrade sometimes recompiles TRT engines (if the `.engine` files are no longer compatible with the new TRT / JetPack).

Compose pulls only the manifest; the actual build happens on your Orin. Expect a few minutes of no video after `compose up -d pipeline`.

Engines are keyed by model variant + precision + JetPack version in the cache directory layout; a JetPack upgrade will force a full re-compile of every engine. Nothing you can do about that — it's a CUDA ABI issue.

## Rolling back images

`docker compose` always pulls the latest tag. To pin:

```yaml
# docker-compose.override.yml
services:
  api:
    image: fnvr-api:2026-04-21
  web:
    image: fnvr-web:2026-04-21
```

## Backup + restore

**Before any major upgrade**, snapshot at least:
- Postgres: `sudo docker exec fnvr-postgres-1 pg_dumpall -U fnvr > fnvr-backup.sql`.
- `/var/lib/fnvr/models/` — ArcFace + SCRFD + detector ONNX + compiled engines.
- `/var/lib/fnvr/thumbs/` — face thumbnail cache, if you want it.
- Anything you've customised under `deploy/config/`.

Recordings (`/var/lib/fnvr/recordings/`) are too big to back up routinely; accept that recordings are recoverable only up to the moment of failure.

Restore: create a fresh Postgres, `psql -U fnvr -f fnvr-backup.sql`, mount the preserved `/var/lib/fnvr/models`, bring up compose, let api-server's migrations bring the schema forward from whatever state the dump was in.

## What's not yet automated

- **Signed OTA** — PLAN.md §7, M6.
- **Staged rollout / boot-failure rollback** — same.
- **Platform vs models update channels** — same.

Today everything is one image tag per service; ship a tag, everyone updates at `docker compose pull`.
