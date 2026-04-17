-- +goose Up
-- +goose StatementBegin

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('superadmin','admin','operator','viewer','guest')),
    disabled    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cameras (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    substream   TEXT,
    record_mode TEXT NOT NULL DEFAULT 'continuous'
                CHECK (record_mode IN ('continuous','motion','event','scheduled','hybrid')),
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    retention_days INTEGER NOT NULL DEFAULT 14,
    quota_gb    INTEGER NOT NULL DEFAULT 200,
    group_id    TEXT NOT NULL DEFAULT 'default',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE zones (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id  TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('polygon','line','tripwire')),
    geometry   JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    definition  JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE detections (
    id         BIGSERIAL PRIMARY KEY,
    event_id   TEXT NOT NULL,
    camera_id  TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    ts         TIMESTAMPTZ NOT NULL,
    class_name TEXT NOT NULL,
    confidence REAL NOT NULL,
    bbox       JSONB NOT NULL,
    track_id   TEXT,
    attributes JSONB
);
CREATE INDEX detections_camera_ts_idx ON detections (camera_id, ts DESC);
CREATE INDEX detections_class_idx    ON detections (class_name);

CREATE TABLE incidents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id       UUID REFERENCES rules(id) ON DELETE SET NULL,
    camera_id     TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ,
    severity      TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','warning','critical')),
    summary       TEXT NOT NULL,
    detection_ids BIGINT[] NOT NULL DEFAULT '{}',
    acknowledged  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX incidents_camera_started_idx ON incidents (camera_id, started_at DESC);

CREATE TABLE segments (
    id           BIGSERIAL PRIMARY KEY,
    camera_id    TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ,
    duration_ms  INTEGER,
    bytes        BIGINT,
    codec        TEXT NOT NULL DEFAULT 'h265',
    protected    BOOLEAN NOT NULL DEFAULT FALSE,
    tier         TEXT NOT NULL DEFAULT 'hot'
                 CHECK (tier IN ('hot','warm','cold'))
);
CREATE INDEX segments_camera_started_idx ON segments (camera_id, started_at DESC);

CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor      TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     JSONB,
    prev_hash  BYTEA,
    row_hash   BYTEA
);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS detections;
DROP TABLE IF EXISTS rules;
DROP TABLE IF EXISTS zones;
DROP TABLE IF EXISTS cameras;
DROP TABLE IF EXISTS users;
-- +goose StatementEnd
