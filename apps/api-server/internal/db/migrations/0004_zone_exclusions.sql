-- +goose Up
-- +goose StatementBegin

-- Per-zone mute lists. When a detection's bbox centre falls inside a
-- polygon zone, the detection is dropped before rule evaluation if:
--   - its class is in exclude_classes (fine-grained, e.g. ['car']) OR
--   - its detector kind is in exclude_kinds (coarse, e.g. ['anpr','face']).
-- Useful e.g. to silence a tree that moves in the wind (class-mute) or to
-- disable plate-reading in a private driveway (kind-mute).
ALTER TABLE zones ADD COLUMN exclude_classes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE zones ADD COLUMN exclude_kinds   TEXT[] NOT NULL DEFAULT '{}';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE zones DROP COLUMN IF EXISTS exclude_classes;
ALTER TABLE zones DROP COLUMN IF EXISTS exclude_kinds;
-- +goose StatementEnd
