-- +goose Up
-- +goose StatementBegin

-- Which detector families should actually fire on each camera. Empty array
-- means "all detectors enabled" (the friendly default so new cameras keep
-- behaving like they always did). A non-empty list is a whitelist — a
-- detection whose kind isn't in it gets dropped before persistence,
-- exactly like a zone-wide kind-mute.
--
-- Use case: ANPR is pointless on internal cameras; face ID may be
-- jurisdiction-sensitive on some cameras but not others.
ALTER TABLE cameras ADD COLUMN enabled_detectors TEXT[] NOT NULL DEFAULT '{}';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP COLUMN IF EXISTS enabled_detectors;
-- +goose StatementEnd
