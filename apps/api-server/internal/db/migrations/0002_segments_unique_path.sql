-- +goose Up
-- +goose StatementBegin

-- Drop duplicate rows (keep the one with the largest bytes, i.e. the
-- most-recently-indexed size of a still-growing file).
DELETE FROM segments a
USING segments b
WHERE a.path = b.path
  AND a.id   < b.id;

ALTER TABLE segments ADD CONSTRAINT segments_path_unique UNIQUE (path);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE segments DROP CONSTRAINT IF EXISTS segments_path_unique;
-- +goose StatementEnd
