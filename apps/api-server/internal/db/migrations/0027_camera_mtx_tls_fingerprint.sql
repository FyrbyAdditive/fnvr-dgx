-- +goose Up
-- +goose StatementBegin

-- Optional SHA256 fingerprint of the upstream's self-signed TLS certificate,
-- used by MediaMTX's RTSPS source when mtx_proxy=true and the source has a
-- cert we don't want to verify (e.g. Bambu H2D uses a self-signed cert with
-- no IP SAN entries, which Go's crypto/tls refuses). Stored uppercase,
-- colon-separated: "AA:BB:CC:...". Empty = standard TLS verification.
--
-- api-server probes the upstream and fills this automatically when the
-- operator ticks "Ignore certificate" in the UI for a camera.
ALTER TABLE cameras ADD COLUMN mtx_tls_fingerprint TEXT NOT NULL DEFAULT '';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP COLUMN IF EXISTS mtx_tls_fingerprint;
-- +goose StatementEnd
