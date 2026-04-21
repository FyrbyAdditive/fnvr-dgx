-- +goose Up
-- +goose StatementBegin

-- Right-to-erasure audit trail. A row lands here whenever an
-- operator deletes a person — demonstrable for compliance reviews
-- and useful for "who deleted Alice and when" forensics.
--
-- Not cascade-deleted: persons can be gone and still have an audit
-- row. person_id is the UUID of the (now-gone) person for
-- bookkeeping; don't foreign-key it.
CREATE TABLE erasure_audit (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id          UUID NOT NULL,
    label              TEXT NOT NULL,
    erased_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Username from the auth session. "system" if the erasure
    -- came from an internal path (none today).
    erased_by_user     TEXT NOT NULL,
    thumbs_removed     INTEGER NOT NULL DEFAULT 0,
    detections_nulled  INTEGER NOT NULL DEFAULT 0,
    embeddings_removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX erasure_audit_erased_at_idx ON erasure_audit (erased_at DESC);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS erasure_audit;
-- +goose StatementEnd
