-- +goose Up
-- +goose StatementBegin

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generated stored column: normalised plate text for fast lookup.
-- Uppercased alphanumerics only; regional spaces / hyphens / dots
-- stripped so a user-typed "AB-12 CDE" and a detector-emitted
-- "AB12CDE" match. NULL when attributes->>'plate' is absent or
-- empty, which keeps storage near-zero for non-ANPR rows.
ALTER TABLE detections
    ADD COLUMN plate TEXT GENERATED ALWAYS AS
        (NULLIF(UPPER(regexp_replace(COALESCE(attributes->>'plate',''), '[^A-Za-z0-9]', '', 'g')), ''))
        STORED;

-- Btree with text_pattern_ops covers equality + LIKE 'AB12%' prefix
-- queries in O(log n). The partial WHERE clause keeps the index
-- small — only ANPR rows end up indexed.
CREATE INDEX detections_plate_btree_idx
    ON detections (plate text_pattern_ops) WHERE plate IS NOT NULL;

-- Trigram GIN covers substring contains ('%12C%') queries. Larger
-- than the btree but still small on the ANPR-only partial set.
CREATE INDEX detections_plate_trgm_idx
    ON detections USING gin (plate gin_trgm_ops) WHERE plate IS NOT NULL;

-- Hotlist table: operator-maintained plates of interest. Matches
-- fire incidents (rule_id NULL); the existing dispatcher + HA
-- bridge carry them on.
CREATE TABLE plate_hotlist (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern    TEXT NOT NULL,
    label      TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'warning'
               CHECK (severity IN ('info','warning','critical')),
    notes      TEXT,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS plate_hotlist;
DROP INDEX IF EXISTS detections_plate_trgm_idx;
DROP INDEX IF EXISTS detections_plate_btree_idx;
ALTER TABLE detections DROP COLUMN IF EXISTS plate;
-- +goose StatementEnd
