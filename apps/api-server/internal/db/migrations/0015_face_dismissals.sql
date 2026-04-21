-- +goose Up
-- +goose StatementBegin

-- Dismissed face detections: operator-tagged "not a face" or
-- "duplicate" thumbnails from the /faces review grid. Each row
-- captures the embedding so the matcher can penalise future
-- detections similar to past false positives (negative-penalty
-- scoring) without waiting for a retrain.
--
-- reason enum is intentionally narrow — broader taxonomy comes
-- with the active-learning slice.
CREATE TABLE face_dismissals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detection_id  TEXT NOT NULL,
    embedding     vector(512) NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('not_a_face', 'duplicate')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotency on operator double-click: a given detection can be
-- dismissed exactly once. Replaces reason silently on re-dismissal.
CREATE UNIQUE INDEX face_dismissals_detection_idx
    ON face_dismissals (detection_id);
-- Matcher veto lookup: ivfflat cosine over the negatives set.
-- Same sizing reasoning as face_embeddings — retune if we grow.
CREATE INDEX face_dismissals_ivf_idx
    ON face_dismissals
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Weight applied to the maximum cosine-to-negative when computing
-- match score. 1.0 == full subtraction (borderline positives that
-- are equally similar to a known negative get rejected); 0.0 ==
-- negatives ignored. Tune down if legitimate matches get vetoed.
INSERT INTO settings (key, value) VALUES
    ('faces.negative_penalty_weight', '1.0')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key = 'faces.negative_penalty_weight';
DROP TABLE IF EXISTS face_dismissals;
-- +goose StatementEnd
