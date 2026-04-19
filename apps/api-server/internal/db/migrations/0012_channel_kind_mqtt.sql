-- +goose Up
-- +goose StatementBegin

-- Extend notification_channels.kind to allow 'mqtt'. DROP + re-CREATE
-- the CHECK since Postgres lacks ALTER CONSTRAINT on CHECK; the
-- existing rows all have valid values so the re-CREATE is safe.
ALTER TABLE notification_channels
    DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels
    ADD CONSTRAINT notification_channels_kind_check
    CHECK (kind IN ('webhook','ntfy','mqtt'));

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE notification_channels
    DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels
    ADD CONSTRAINT notification_channels_kind_check
    CHECK (kind IN ('webhook','ntfy'));
-- +goose StatementEnd
