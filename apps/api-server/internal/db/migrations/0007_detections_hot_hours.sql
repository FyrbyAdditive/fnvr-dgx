-- +goose Up
-- +goose StatementBegin

-- How long detections live in Postgres. Older detections are read from
-- per-segment JSONL sidecar files written by event-processor. Storage-
-- manager's retention loop prunes rows older than this and keeps
-- Postgres small regardless of camera retention_days.
INSERT INTO settings (key, value) VALUES ('detections.hot_hours', '24')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key = 'detections.hot_hours';
-- +goose StatementEnd
