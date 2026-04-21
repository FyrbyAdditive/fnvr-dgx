-- +goose Up
-- +goose StatementBegin

-- Face enrolment: a labelled identity. Multiple embeddings per
-- person; enrolment improves over time by simply adding more rows.
-- alert_on_match mirrors plate_hotlist semantics: a match fires a
-- rule-less incident via the dispatcher + HA bridge.
CREATE TABLE persons (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label      TEXT NOT NULL,
    notes      TEXT,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    alert_on_match BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX persons_label_idx ON persons (label);

-- pgvector extension already enabled in 0001_init.sql.
-- ArcFace R100 outputs 512-d float vectors; cosine ≈ 0.4 same-ID cutoff.
CREATE TABLE face_embeddings (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id  UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    embedding  vector(512) NOT NULL,
    -- Free-form: "enrol-live-<detection_id>" today; later "upload-<file>".
    source     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX face_embeddings_person_idx ON face_embeddings (person_id);
-- IVFFlat with cosine works well at <10k embeddings; retune lists
-- if the fleet grows. pgvector recommends lists = rows/1000.
CREATE INDEX face_embeddings_ivf_idx
    ON face_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Cosine similarity floor for "this detection matches this person".
-- ArcFace R100 norm'd cosine ~0.35 is the usual same-identity
-- threshold; default slightly conservative so new operators don't
-- hit false positives right away.
INSERT INTO settings (key, value) VALUES
    ('faces.match_threshold', '0.40')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key = 'faces.match_threshold';
DROP TABLE IF EXISTS face_embeddings;
DROP INDEX IF EXISTS persons_label_idx;
DROP TABLE IF EXISTS persons;
-- +goose StatementEnd
