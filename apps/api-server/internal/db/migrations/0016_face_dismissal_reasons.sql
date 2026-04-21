-- +goose Up
-- +goose StatementBegin

-- Widen the set of allowed dismissal reasons. Only 'not_a_face' feeds
-- the matcher's negative-penalty scorer; the others are UI-only hides.
--   deleted  — operator clicked "delete" to remove a redundant/ugly
--              tile without flagging it as a false positive.
--   enrolled — post-save autohide so a just-enrolled tile doesn't
--              linger as "unmatched" until the next matcher reload.
ALTER TABLE face_dismissals
    DROP CONSTRAINT IF EXISTS face_dismissals_reason_check;
ALTER TABLE face_dismissals
    ADD  CONSTRAINT face_dismissals_reason_check
    CHECK (reason IN ('not_a_face', 'duplicate', 'deleted', 'enrolled'));

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
-- Drop any rows that would violate the narrower check, then restore.
DELETE FROM face_dismissals WHERE reason NOT IN ('not_a_face', 'duplicate');
ALTER TABLE face_dismissals
    DROP CONSTRAINT IF EXISTS face_dismissals_reason_check;
ALTER TABLE face_dismissals
    ADD  CONSTRAINT face_dismissals_reason_check
    CHECK (reason IN ('not_a_face', 'duplicate'));
-- +goose StatementEnd
