-- +goose Up
-- +goose StatementBegin

-- Storage-manager tunables. Served through the existing settings
-- key/value so an admin can tune without a restart / migration.
--
-- storage.min_free_pct: emergency-purge floor. When free disk drops
-- below this percent, storage-manager evicts oldest segments across
-- all cameras until free% >= floor. Clamped to [0, 50] on read; a
-- higher ceiling is probably a config mistake rather than real intent.
INSERT INTO settings (key, value) VALUES
    ('storage.min_free_pct', '10.0')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key IN (
    'storage.min_free_pct'
);
-- +goose StatementEnd
