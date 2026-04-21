-- +goose Up
-- +goose StatementBegin

-- Drop NOT NULL on incidents.camera_id so system-scope incidents
-- (drift alerts, future global ML events) can sit alongside
-- per-camera ones without a synthetic attribution. The FK stays put:
-- ON DELETE CASCADE still cleans per-camera rows when a camera goes
-- away, and a NULL camera_id is simply ignored by that constraint.
--
-- The notification-dispatcher's subscription filter is already
-- (s.camera_id IS NULL OR s.camera_id = $incident.camera_id), so a
-- NULL on the incident side falls through the IS NULL leg and reaches
-- every subscription that doesn't pin a camera. Per-camera-pinned
-- subscriptions correctly skip system-scope incidents.
ALTER TABLE incidents
    ALTER COLUMN camera_id DROP NOT NULL;

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin

-- Reverting requires every existing incidents row to have a non-NULL
-- camera_id. If system-scope rows have been written by then the Down
-- will fail; that's intentional — don't silently drop incident rows.
ALTER TABLE incidents
    ALTER COLUMN camera_id SET NOT NULL;

-- +goose StatementEnd
