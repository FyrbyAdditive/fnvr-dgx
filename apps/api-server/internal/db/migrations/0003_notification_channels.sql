-- +goose Up
-- +goose StatementBegin

CREATE TABLE notification_channels (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('webhook','ntfy')),
    config     JSONB NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bridge table: which channels are subscribed to which rules. NULL rule_id
-- means "subscribe to every incident". Per-camera filtering is layered
-- on top via the optional camera_id column.
CREATE TABLE notification_subscriptions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    rule_id    UUID REFERENCES rules(id) ON DELETE CASCADE,
    camera_id  TEXT REFERENCES cameras(id) ON DELETE CASCADE,
    min_severity TEXT NOT NULL DEFAULT 'info'
                 CHECK (min_severity IN ('info','warning','critical')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notification_subscriptions_channel_idx ON notification_subscriptions (channel_id);

-- Delivery log: fire-and-log so operators can audit whether a channel
-- actually delivered. One row per (incident, channel, attempt).
CREATE TABLE notification_deliveries (
    id          BIGSERIAL PRIMARY KEY,
    incident_id UUID NOT NULL,
    channel_id  UUID NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    succeeded   BOOLEAN NOT NULL,
    status_code INTEGER,
    error       TEXT
);
CREATE INDEX notification_deliveries_incident_idx ON notification_deliveries (incident_id);
CREATE INDEX notification_deliveries_channel_ts_idx ON notification_deliveries (channel_id, attempted_at DESC);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_subscriptions;
DROP TABLE IF EXISTS notification_channels;
-- +goose StatementEnd
