-- +goose Up
-- +goose StatementBegin

-- Per-camera software rotation (degrees, clockwise) for cameras that can't
-- be physically reoriented. Applied in the GStreamer graph before the
-- recording encoder so both segments and WHEP live view see the rotated
-- frames. Default 0 keeps every existing camera unchanged.
ALTER TABLE cameras
    ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0
    CHECK (rotation IN (0, 90, 180, 270));

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP COLUMN IF EXISTS rotation;
-- +goose StatementEnd
