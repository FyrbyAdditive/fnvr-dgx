-- +goose Up
-- +goose StatementBegin

-- Home Assistant bridge config. Disabled by default so an upgrade
-- doesn't start publishing to whatever broker URL happens to be in
-- the sample. Admin enables it from the Settings UI once the broker
-- is up.
INSERT INTO settings (key, value) VALUES (
    'ha.config',
    '{"enabled":false,"broker_url":"tcp://mosquitto:1883","username":"","password":"","discovery_prefix":"homeassistant","topic_prefix":"fnvr"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key = 'ha.config';
-- +goose StatementEnd
