-- +goose Up
-- +goose StatementBegin

-- fnvr-dgx runs on DGX Spark (GB10): the Blackwell GPU vastly outclasses
-- the Hailo-8 PCIe accelerator the Orin build offered, so the hailo
-- backend is gone. Fold any hailo cameras back onto the GPU path and
-- tighten the CHECK so the value can't reappear. The column itself is
-- kept (defaulted 'trt') so a future alternate backend can reuse it
-- without another table rewrite.
UPDATE cameras SET detector_backend = 'trt' WHERE detector_backend = 'hailo';

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_detector_backend_check;
ALTER TABLE cameras
    ADD CONSTRAINT cameras_detector_backend_check
    CHECK (detector_backend IN ('trt'));

-- The hailo-broker's model-version setting has no consumer anymore.
DELETE FROM settings WHERE key = 'detector.hailo_model_version';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_detector_backend_check;
ALTER TABLE cameras
    ADD CONSTRAINT cameras_detector_backend_check
    CHECK (detector_backend IN ('trt', 'hailo'));
-- +goose StatementEnd
