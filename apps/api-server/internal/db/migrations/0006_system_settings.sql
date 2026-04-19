-- +goose Up
-- +goose StatementBegin

-- Generic key/value store for system-wide settings. Keys are hierarchical
-- by convention (e.g. "detector.yolo26_variant"); values are JSON so we
-- can keep schema evolution in the application layer instead of adding
-- a new column every time.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default primary-detector variant + precision. The pipeline container's
-- entrypoint reads these (via the api) to choose the nvinfer config. An
-- operator can override them from the Settings page.
INSERT INTO settings (key, value) VALUES
    ('detector.yolo26_variant',   '"yolo26x"'),
    ('detector.yolo26_precision', '"fp16"');

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS settings;
-- +goose StatementEnd
