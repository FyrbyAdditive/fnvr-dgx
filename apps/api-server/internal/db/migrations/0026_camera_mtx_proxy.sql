-- +goose Up
-- +goose StatementBegin

-- Per-camera toggle: when true, the pipeline worker pulls its stream from
-- the local MediaMTX re-muxer instead of directly from the camera. Used to
-- launder broken RTSP sources (corrupt H.264, Rockchip rtsp_demo, etc.)
-- by letting a software demuxer re-normalise the bitstream before we
-- record or feed it into NVDEC.
--
-- Only meaningful alongside enabled_detectors = ["none"] today — an
-- AI-enabled camera already has its path through NVDEC, which tolerates
-- the kinds of framing quirks that break qtmux. The UI hides the toggle
-- for AI-enabled cameras; the backend ignores it if set (no hard
-- constraint so the two columns stay independent).
ALTER TABLE cameras ADD COLUMN mtx_proxy BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE cameras DROP COLUMN IF EXISTS mtx_proxy;
-- +goose StatementEnd
