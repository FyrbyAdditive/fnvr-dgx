-- +goose Up
-- +goose StatementBegin

-- Incident merging: temporal + cross-rule grouping.
--
-- Until now, every detection that passed a rule's gates fired a new
-- incident row. CooldownSec on the rule blocked rapid re-firing but
-- never merged: a single car parked in view for 30 minutes turned
-- into ~10 separate rows. Worse, the unit of grouping was
-- (rule_id, camera_id) — so person + car arriving at the same camera
-- in the same minute were two unrelated rows even though it's one
-- event to a human reviewer.
--
-- The new model: incidents are camera-scoped and time-bucketed. A
-- rule firing within `merge_window_sec` of the most recent incident
-- on the same camera UPDATEs that incident (bumps the heartbeat,
-- adds its rule_id and class to the running sets, raises severity if
-- needed). The first firing in a fresh window INSERTs.
--
-- This collapses the same car visible for 10 min into one row, AND
-- collapses person + car at the same camera into one row tagged
-- with both classes. Cross-camera merging is deliberately NOT done
-- here — sequence rules already encode cross-camera correlation.
ALTER TABLE incidents
    -- Set of class names contributing to the incident (e.g.
    -- {person,car}). UI prints these joined ("person + car at
    -- house-side") instead of the original single-class summary.
    -- Append-only inside the merge window.
    ADD COLUMN classes           TEXT[]      NOT NULL DEFAULT '{}',
    -- Set of rule_ids that contributed. Audit trail; UI may show
    -- "matched 3 rules" on hover.
    ADD COLUMN rule_ids          UUID[]      NOT NULL DEFAULT '{}',
    -- Heartbeat updated on every detection that merges in. Drives
    -- the merge-window lookup (newest-first per camera).
    ADD COLUMN last_detection_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Number of detections folded in. Surfaced in UI as "×N"
    -- alongside the duration.
    ADD COLUMN detection_count   INTEGER     NOT NULL DEFAULT 1;

-- Backfill so old rows behave sensibly under the new schema:
--   - last_detection_at = started_at (we don't have a better signal)
--   - rule_ids = [rule_id] when present (existing single rule_id
--     becomes the singleton set)
--   - classes = first token of summary (best effort)
--   - detection_count keeps its default of 1
--
-- We unconditionally UPDATE every existing row because the new
-- columns just got added with DEFAULT NOW() / DEFAULT '{}' which
-- means a "WHERE last_detection_at = started_at" check never
-- matches (DEFAULT NOW() makes them equal to the migration time,
-- not to started_at). Migration 0032 carries an identical fix-up
-- in case 0031 already ran on a DB before this fix landed.
UPDATE incidents
   SET last_detection_at = started_at,
       rule_ids = CASE WHEN rule_id IS NOT NULL
                       THEN ARRAY[rule_id] ELSE '{}'::uuid[] END,
       classes = CASE
           WHEN summary IS NOT NULL AND position(' ' IN summary) > 0
           THEN ARRAY[split_part(summary, ' ', 1)]
           ELSE '{}'::text[]
       END;

-- Hot-path index for the merge lookup. The engine queries:
--   SELECT id FROM incidents
--    WHERE camera_id = $1 AND last_detection_at >= $2
--    ORDER BY last_detection_at DESC LIMIT 1
-- This index serves it directly, with the WHERE camera_id filter
-- and the DESC ordering both natively satisfied.
CREATE INDEX incidents_merge_lookup_idx
    ON incidents (camera_id, last_detection_at DESC);

-- severity_rank: maps the severity TEXT values to a comparable
-- integer so the merge UPDATE can pick the higher of (existing,
-- incoming) without joining on a lookup table. SQL function so
-- it inlines into the planner.
CREATE OR REPLACE FUNCTION severity_rank(s TEXT)
RETURNS INT AS $$
    SELECT CASE s
        WHEN 'critical' THEN 3
        WHEN 'warning'  THEN 2
        WHEN 'info'     THEN 1
        ELSE 0
    END
$$ LANGUAGE SQL IMMUTABLE;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS severity_rank(TEXT);
DROP INDEX IF EXISTS incidents_merge_lookup_idx;
ALTER TABLE incidents
    DROP COLUMN IF EXISTS detection_count,
    DROP COLUMN IF EXISTS last_detection_at,
    DROP COLUMN IF EXISTS rule_ids,
    DROP COLUMN IF EXISTS classes;
-- +goose StatementEnd
