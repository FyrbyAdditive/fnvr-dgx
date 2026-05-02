-- +goose Up
-- +goose StatementBegin

-- Phase B: convert detections.phash from a GENERATED STORED column
-- (derived from attributes->>'phash') to a plain BIGINT populated by
-- event-processor on insert. This unlocks the storage win — once
-- event-processor strips the "phash" key from attributes before
-- writing the JSONB, plain-object rows can land with attributes=NULL
-- entirely.
--
-- Postgres 16 supports ALTER COLUMN ... DROP EXPRESSION which would
-- preserve values in place. We use it when available; if we ever run
-- on a version without it, the equivalent is drop+add+backfill, but
-- backfilling 235k rows is bounded (sub-second on NVMe + tuned
-- shared_buffers). Either way, the bit pattern of the existing values
-- is what we want to keep.

ALTER TABLE detections ALTER COLUMN phash DROP EXPRESSION;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin

-- Reverse: restore the GENERATED expression so older event-processor
-- builds (which don't pass phash to the INSERT) keep populating the
-- column from attributes. Drop and re-add since you can't add an
-- expression to an existing column.
ALTER TABLE detections DROP COLUMN phash;
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
CREATE INDEX detections_phash_idx
    ON detections (phash) WHERE phash IS NOT NULL;

-- +goose StatementEnd
