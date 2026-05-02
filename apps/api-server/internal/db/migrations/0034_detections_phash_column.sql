-- +goose Up
-- +goose StatementBegin

-- Promote attributes.phash → typed BIGINT column. The pipeline
-- emits phash as a 16-char lowercase hex string under
-- attributes.phash; we parse it via the standard hex-to-int trick
-- ('x' || hex)::bit(64)::bigint. NULL when the row has no phash
-- (face / anpr detections, or rare object detections where the
-- crop-hash failed) so the partial index stays object-only.
--
-- Same shape as migration 0013_plate_hotlist's plate column —
-- generated stored from attributes JSONB, partial index for the
-- non-NULL subset.
ALTER TABLE detections
    ADD COLUMN phash BIGINT GENERATED ALWAYS AS (
        CASE
            WHEN attributes ? 'phash'
              AND length(attributes->>'phash') = 16
              AND attributes->>'phash' ~ '^[0-9a-f]+$'
            THEN ('x' || (attributes->>'phash'))::bit(64)::bigint
            ELSE NULL
        END
    ) STORED;

-- Partial index on the object-only subset. The hot suppression path
-- in event-processor checks (camera, class, phash) via an in-memory
-- map, so this isn't a perf-critical index — it's for ad-hoc operator
-- queries ("which detections matched this flagged phash?").
CREATE INDEX detections_phash_idx
    ON detections (phash) WHERE phash IS NOT NULL;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS detections_phash_idx;
ALTER TABLE detections DROP COLUMN IF EXISTS phash;
-- +goose StatementEnd
