-- +goose Up
-- +goose StatementBegin

-- Calibration status surface for the yolo26 INT8 workflow. Three
-- settings rows track:
--   image_count — how many JPEGs are currently under
--                 /var/lib/fnvr/models/yolo26/calib_images/.
--                 Updated by the api-server sampler goroutine and by
--                 the pipeline entrypoint before it kicks trtexec.
--   last_run    — ISO-8601 of the last time the pipeline entrypoint
--                 attempted calibration; null until the first run.
--   last_error  — human-readable error string from the last failed
--                 calibration (e.g. tail of calibrate.log). NULL on
--                 success so the UI can distinguish "never run" from
--                 "ran and failed".
INSERT INTO settings (key, value) VALUES
    ('calibration.image_count', '0'),
    ('calibration.last_run',    'null'),
    ('calibration.last_error',  'null')
ON CONFLICT (key) DO NOTHING;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DELETE FROM settings WHERE key IN (
    'calibration.image_count',
    'calibration.last_run',
    'calibration.last_error'
);
-- +goose StatementEnd
