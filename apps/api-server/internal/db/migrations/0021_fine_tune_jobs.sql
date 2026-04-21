-- +goose Up
-- +goose StatementBegin

-- Fine-tune job ledger. Populated when the ml-worker's TAO training
-- path is wired up (future slice — scaffolding only in this one).
-- Survives container restarts so shadow-mode A/B results don't
-- evaporate.
--
-- state transitions:
--   queued   — row created, not yet training
--   running  — TAO job is actively training
--   shadow   — candidate model running alongside production,
--              collecting delta metrics
--   promoted — operator accepted the candidate; arcface.onnx on
--              disk has been atomically renamed to the new weights
--   failed   — any of the above errored; `notes` has the tail
CREATE TABLE fine_tune_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state       TEXT NOT NULL
        CHECK (state IN ('queued', 'running', 'shadow', 'promoted', 'failed')),
    model       TEXT NOT NULL DEFAULT 'arcface',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    -- JSONB so the shadow-mode runner can dump whatever metrics
    -- it wants (mean similarity delta, false-match rate,
    -- cluster purity, etc.) without schema churn.
    metrics     JSONB,
    onnx_path   TEXT,
    notes       TEXT
);
CREATE INDEX fine_tune_jobs_state_idx ON fine_tune_jobs (state);

-- ml-worker + clustering config + drift baseline. All stored in the
-- existing settings key/value table so the admin UI can tweak them
-- without a migration.
INSERT INTO settings (key, value) VALUES
    -- Nightly cron for /batch-cluster inside the ml-worker. Local
    -- time per FNVR_TZ env. "HH:MM" 24h.
    ('ml.cluster.batch_schedule',  '"03:00"'),
    -- HDBSCAN parameter — smaller = more clusters, more noise
    -- labelled as clusters. 3 is a sensible default for CCTV where
    -- incidental visitors appear a handful of times.
    ('ml.cluster.min_cluster_size', '3'),
    -- Progress / outcome of the most recent run. Updated by the
    -- api-server's clusterRunNow goroutine and the ml-worker's
    -- scheduler, same settings-row pattern we used for calibration.
    ('ml.cluster.last_run_state',   'null'),
    ('ml.cluster.last_run_error',   'null'),
    -- Baseline self-match cosine from the most recent successful
    -- drift check. Null until first run. Subsequent checks compare
    -- against this and alert on ≥5% drop.
    ('ml.drift.baseline_self_match', 'null')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key IN (
    'ml.cluster.batch_schedule',
    'ml.cluster.min_cluster_size',
    'ml.cluster.last_run_state',
    'ml.cluster.last_run_error',
    'ml.drift.baseline_self_match'
);
DROP TABLE IF EXISTS fine_tune_jobs;
-- +goose StatementEnd
