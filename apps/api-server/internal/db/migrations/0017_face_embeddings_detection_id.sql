-- +goose Up
-- +goose StatementBegin

-- Link each enrolled embedding back to the detection it was enrolled
-- from. Nullable because rows predating this migration don't have the
-- linkage — their `source` column has a "enrol-live-{event_id}" or
-- "enrol-cluster-{detection_id}" string that doesn't round-trip
-- cleanly to a PG id.
--
-- The Faces UI uses this to show the cached face JPEG next to each
-- embedding (served via /api/v1/faces/thumbnail/{detection_id}.jpg),
-- so operators can see which face sample each embedding represents
-- and delete any that look wrong.
ALTER TABLE face_embeddings
    ADD COLUMN IF NOT EXISTS detection_id BIGINT;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE face_embeddings DROP COLUMN IF EXISTS detection_id;
-- +goose StatementEnd
