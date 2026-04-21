# Migrations

We use [goose](https://github.com/pressly/goose) embedded in api-server. The migration directory is [apps/api-server/internal/db/migrations/](../../apps/api-server/internal/db/migrations/). api-server runs `goose up` on start; no manual step.

## Conventions

- **Filenames: `NNNN_name.sql`.** Sequential, never reused.
- **Both Up and Down blocks.** Down should be safe on clean data. Where a Down can't be safe (e.g. dropping a nullable column that has NULLs now), the Down fails deliberately — we don't silently lose rows.
- **One migration per logical change.** Don't bundle three unrelated schema edits.
- **Never rewrite a landed migration.** Even if it's "just a comment fix" — goose hashes the filename, not the content, but rewriting creates drift between fresh installs and existing ones.
- **Seed with `ON CONFLICT (key) DO NOTHING`** so reruns are idempotent.
- **StatementBegin / StatementEnd** around any multi-statement SQL so goose parses them correctly.

## Template

```sql
-- +goose Up
-- +goose StatementBegin

ALTER TABLE incidents
    ALTER COLUMN camera_id DROP NOT NULL;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin

-- Reverting requires every existing row to have a non-NULL value.
-- If system-scope rows exist by then, the Down will fail — intentional;
-- we don't drop the affected rows.
ALTER TABLE incidents
    ALTER COLUMN camera_id SET NOT NULL;

-- +goose StatementEnd
```

## Adding one

```bash
# Figure out the next number.
ls apps/api-server/internal/db/migrations | tail
# → 0023_incidents_system_scope.sql

# Write 0024_whatever.sql in the same dir. Up + Down as above.

# Test it lands cleanly on a fresh DB:
docker compose -f deploy/docker/docker-compose.yml down -v
docker compose -f deploy/docker/docker-compose.yml up -d postgres api

# Test it lands on an existing DB (the real world scenario):
docker compose -f deploy/docker/docker-compose.yml up -d api
# check api logs for "goose: successfully migrated database to version: 24"
```

## Recent migrations (2026)

| # | What |
|---|---|
| 0014 | faces (persons + face_embeddings + pgvector ivfflat index) |
| 0015 | face_dismissals |
| 0016 | face_dismissal_reasons (`not_a_face`, `duplicate`, `deleted`, `enrolled`) |
| 0017 | face_embeddings.detection_id (thumbnail breadcrumb) |
| 0018 | calibration_status (INT8 calibration state — see [known-issues](../operations/known-issues.md)) |
| 0019 | face_clusters + face_cluster_members |
| 0020 | erasure_audit |
| 0021 | fine_tune_jobs + ml.* settings keys |
| 0022 | storage.min_free_pct seed |
| 0023 | incidents.camera_id DROP NOT NULL |

## Tests

There are no schema-drift tests today. If one is needed, the pattern would be: spin up a fresh Postgres, let goose migrate forward, then snapshot `\d` output and diff against a golden file in the tree. Not yet warranted.

## Rolling back in production

Please don't, unless absolutely necessary. Restore from backup instead — `goose down` is conservatively safe, but an operational error with it is a lot harder to recover from than a pg_dump restore. See [operations/upgrade.md § backup + restore](../operations/upgrade.md#backup--restore).
