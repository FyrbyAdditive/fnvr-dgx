-- +goose Up
-- +goose StatementBegin

-- Camera-agnostic hot query shapes had no supporting index:
--
--   kind='face' AND ts range ORDER BY ts DESC LIMIT n
--     /faces/recent (15s poll), timeline notable fan-out (10s),
--     person matches — previously gathered every matching-kind row
--     in the window via detections_kind_idx then sorted.
--   segments ORDER BY started_at DESC (fleet timeline overview, 10s)
--   incidents ORDER BY started_at DESC (events feed, 5s)
--     — the (camera_id, started_at) indexes can't serve either
--     without a camera predicate.
--
-- All three become bounded index scans that stop at LIMIT.

CREATE INDEX IF NOT EXISTS detections_kind_ts_idx
  ON detections (kind, ts DESC);

-- Superseded: the composite above serves plain kind= equality too.
DROP INDEX IF EXISTS detections_kind_idx;

CREATE INDEX IF NOT EXISTS segments_started_idx
  ON segments (started_at DESC);

CREATE INDEX IF NOT EXISTS incidents_started_idx
  ON incidents (started_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS detections_kind_ts_idx;
CREATE INDEX IF NOT EXISTS detections_kind_idx ON detections (kind);
DROP INDEX IF EXISTS segments_started_idx;
DROP INDEX IF EXISTS incidents_started_idx;
-- +goose StatementEnd
