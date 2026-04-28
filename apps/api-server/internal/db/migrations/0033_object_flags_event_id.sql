-- +goose Up
-- +goose StatementBegin

-- The thumbnail file on disk is keyed by the detection's event_id
-- (a short hex string written by the pipeline at probe time). The
-- /api/v1/object-thumbnail endpoint used to look that event_id up
-- via JOIN to the detections table at request time.
--
-- That worked until detection retention pruned the source rows out
-- from under the flag — at which point the JOIN returns nothing and
-- the thumbnail endpoint 404s, even though the JPEG is still on disk.
--
-- The flag row already carries its own snapshot of class + bbox +
-- phash + frame_path; adding event_id to that snapshot is the same
-- pattern. The endpoint can then read event_id directly from the
-- flag row and serve the JPEG without ever touching detections.
ALTER TABLE object_flags
    ADD COLUMN IF NOT EXISTS event_id text;

-- Backfill from any detections that haven't been pruned yet. Flags
-- whose source detection is gone stay NULL — the endpoint will
-- 404 for those (the JPEG was almost certainly pruned alongside).
-- Flags created from now on populate event_id at insert time.
UPDATE object_flags f
SET event_id = d.event_id
FROM detections d
WHERE f.event_id IS NULL
  AND f.detection_id IS NOT NULL
  AND d.id = f.detection_id;

-- Helps the thumbnail handler do a single-row lookup by id.
-- (No btree on event_id itself — every read is via the flag's PK.)

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin

ALTER TABLE object_flags DROP COLUMN IF EXISTS event_id;

-- +goose StatementEnd
