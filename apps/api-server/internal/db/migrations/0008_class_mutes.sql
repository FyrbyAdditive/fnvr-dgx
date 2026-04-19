-- +goose Up
-- +goose StatementBegin

-- Class-mute hierarchy. Three global buckets in settings + two
-- per-camera override arrays + a location tag that selects which
-- bucket applies. Resolution (see rules/engine.go):
--
--   muted(cam, class) ⇔
--     class ∈ ((global ∪ bucket(cam.location_kind)) \ cam.unmute_override)
--            ∪ cam.mute_override
--
-- Arrays (not JSONB) so the engine can scan them identically to
-- cameras.enabled_detectors.

INSERT INTO settings (key, value) VALUES
    ('classes.disabled.global',  '[]'::jsonb),
    ('classes.disabled.indoor',  '[]'::jsonb),
    ('classes.disabled.outdoor', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE cameras
    ADD COLUMN location_kind TEXT
        CHECK (location_kind IN ('indoor','outdoor') OR location_kind IS NULL)
        DEFAULT NULL,
    ADD COLUMN mute_classes_override   TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN unmute_classes_override TEXT[] NOT NULL DEFAULT '{}';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras
    DROP COLUMN IF EXISTS location_kind,
    DROP COLUMN IF EXISTS mute_classes_override,
    DROP COLUMN IF EXISTS unmute_classes_override;

DELETE FROM settings WHERE key IN (
    'classes.disabled.global',
    'classes.disabled.indoor',
    'classes.disabled.outdoor'
);
-- +goose StatementEnd
