-- +goose Up
-- +goose StatementBegin

-- Per-camera inference backend for the primary object-detection leg
-- of the pipeline. "trt" is the existing DeepStream nvinfer PGIE path
-- (TensorRT on the Orin GPU); "hailo" routes via hailonet to the
-- Hailo-8 PCIe accelerator, freeing the GPU for SGIEs + encode work.
--
-- Per-camera so an operator can migrate one camera at a time, and
-- choose which cameras get the scarce Hailo compute when more cameras
-- exist than the Hailo can reasonably serve.
--
-- Default 'trt' keeps every existing camera unchanged. Tracker + ANPR
-- SGIEs + face SGIEs stay on GPU regardless of backend — only the
-- primary detection leg moves.
ALTER TABLE cameras
    ADD COLUMN detector_backend TEXT NOT NULL DEFAULT 'trt'
    CHECK (detector_backend IN ('trt', 'hailo'));

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP COLUMN IF EXISTS detector_backend;
-- +goose StatementEnd
