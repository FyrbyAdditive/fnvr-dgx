# api-server

Go service. Single binary under `cmd/api/`. Owns:

- REST API at `:8081` (session auth + API tokens).
- Server-Sent Events at `/api/v1/events/stream`.
- Prometheus scrape at `/metrics`.
- WebRTC WHEP offer proxy at `/api/v1/cameras/{id}/whep`.
- Runtime configuration (`settings` table) + all schema migrations.
- Auth (sessions, admin vs viewer roles, API tokens), RBAC, GDPR erasure audit.

Package layout and conventions live in [docs/developer/repo-layout.md](../../docs/developer/repo-layout.md). Handler files under [internal/server/](internal/server/) are one file per concern.

## Migrations

Goose, embedded. See [docs/developer/migrations.md](../../docs/developer/migrations.md).

## Metrics

Prometheus client + middleware that wraps the main mux. See [docs/developer/metrics.md](../../docs/developer/metrics.md).

## Config

`apps/api-server/internal/config/config.go`. Reads `FNVR_HTTP_ADDR`, `FNVR_DATABASE_URL`, `FNVR_NATS_URL`, `FNVR_DATA_DIR`, `FNVR_MTX_API_URL` from env. Everything else lives in the `settings` key/value table — see [docs/operations/settings.md](../../docs/operations/settings.md).
