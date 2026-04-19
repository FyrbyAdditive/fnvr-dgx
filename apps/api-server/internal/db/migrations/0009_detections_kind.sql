-- +goose Up
-- +goose StatementBegin

-- Add the detector kind to the hot detections table so queries like
-- "all ANPR events yesterday" don't need to probe the attributes JSONB.
-- Also indexed for that query path.
--
-- Default "object" matches the pre-ANPR behaviour — every existing row
-- was object detection. Once event-processor ships with kind writes,
-- plate rows land with kind = 'anpr', face rows 'face'.
ALTER TABLE detections ADD COLUMN kind TEXT NOT NULL DEFAULT 'object';
CREATE INDEX detections_kind_idx ON detections (kind);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS detections_kind_idx;
ALTER TABLE detections DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
