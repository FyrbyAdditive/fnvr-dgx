-- +goose Up
-- +goose StatementBegin

-- Fix-up for migration 0031.
--
-- The previous backfill UPDATE in 0031 had the wrong WHERE clause
-- (it relied on identifying "newly added" rows by the new columns
-- equalling their defaults, but the defaults were `NOW()` and `'{}'`
-- which match what the migration actually wrote, so the COALESCE
-- branch never fired). Result on the live DB: every existing
-- incident's last_detection_at is the migration timestamp, and
-- rule_ids / classes are empty arrays.
--
-- This migration patches the historic rows so their derived columns
-- describe their original single-detection event:
--   last_detection_at = started_at
--   rule_ids          = [rule_id] (when not null)
--   classes           = first word of summary (best effort)
--
-- We can be aggressive with the WHERE clause here: any row where
-- last_detection_at is more than 1s past started_at AND
-- detection_count = 1 is, by definition, a row that was never
-- merged into and pre-dates the merge logic — so it's safe to
-- reset its derived columns.

UPDATE incidents
   SET last_detection_at = started_at,
       rule_ids = CASE WHEN rule_id IS NOT NULL
                       THEN ARRAY[rule_id]
                       ELSE rule_ids END,
       -- Try to extract the class name from the summary string,
       -- which has the shape "<class> on <camera> (<conf>%)". The
       -- first space-separated token is the class. If parsing
       -- fails we keep the empty array.
       classes = CASE
           WHEN array_length(classes, 1) IS NULL  -- empty
                AND summary IS NOT NULL
                AND position(' ' IN summary) > 0
           THEN ARRAY[split_part(summary, ' ', 1)]
           ELSE classes
       END
 WHERE detection_count = 1
   AND last_detection_at > started_at + interval '1 second';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
-- This migration is a fix-up; reverting it would leave the rows in
-- the broken state migration 0031's backfill produced. No-op down.
SELECT 1;
-- +goose StatementEnd
