-- +goose Up
-- +goose StatementBegin

-- Object-detection false-positive + relabel flags.
--
-- Each row corresponds to one operator action: "this bbox from
-- YOLO is wrong, suppress future matches AND record it for off-device
-- training." Two outputs:
--   1. Suppression library loaded by event-processor every 30 s,
--      keyed (camera_id, class_original) for fast per-detection
--      lookup. Suppression uses pHash Hamming distance on the bbox
--      crop; see docs/architecture/rules-engine.md.
--   2. A YOLO-format dataset tree on disk under
--      /var/lib/fnvr/datasets/objects/ so the flags survive model
--      upgrades and can train a future detector on a proper GPU box.
--
-- detection_id is NOT a FK: detection rows get pruned by the hot-table
-- retention policy (settings.detections_hot_hours). We still keep the
-- id on the flag for audit + for re-finding the original crop if
-- needed before pruning runs.
CREATE TABLE object_flags (
    id              BIGSERIAL PRIMARY KEY,
    detection_id    BIGINT NOT NULL,
    camera_id       TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    ts              TIMESTAMPTZ NOT NULL,

    -- What YOLO called it; drives the suppression keyspace.
    class_original  TEXT NOT NULL,
    -- Operator correction: NULL means "this is nothing — suppress",
    -- non-null means "actually it's a <class>" and the YOLO-format
    -- label file carries the correction for future training.
    class_corrected TEXT,

    bbox            JSONB NOT NULL,
    -- 64-bit perceptual hash of the bbox crop as emitted by the
    -- pipeline probe. Event-processor computes Hamming distance vs
    -- incoming probe pHash for same-camera same-class detections.
    phash           BIGINT NOT NULL,

    -- Relative to FNVR_DATA_DIR so the row survives a mount move.
    frame_path      TEXT NOT NULL,
    label_path      TEXT NOT NULL,

    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Soft delete so the dataset-on-disk stays curatable without
    -- physically rebuilding the tree. Event-processor's active-flag
    -- reload filters WHERE dismissed_at IS NULL.
    dismissed_at    TIMESTAMPTZ
);

-- Partial index on the active keyspace the matcher hits every
-- detection. Dismissed rows are excluded so a growing audit trail
-- doesn't slow the fast path.
CREATE INDEX object_flags_active_idx
    ON object_flags (camera_id, class_original)
    WHERE dismissed_at IS NULL;

-- Surfaced on the Flags page; ordered lookup.
CREATE INDEX object_flags_created_at_idx
    ON object_flags (created_at DESC);

-- Suppression sensitivity. Hamming distance threshold on the 64-bit
-- pHash; smaller = tighter match (fewer false suppressions, more
-- missed suppressions); range [4, 16]; default 8 is the standard
-- pHash identity cutoff.
INSERT INTO settings (key, value) VALUES
    ('detections.suppression_hamming_threshold', '8')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key = 'detections.suppression_hamming_threshold';
DROP TABLE IF EXISTS object_flags;
-- +goose StatementEnd
