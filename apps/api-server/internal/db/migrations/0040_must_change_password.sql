-- +goose Up
-- +goose StatementBegin

-- Forces a first-login password change. The bootstrap admin is created
-- with this set (and a random password); the self-service change-password
-- flow clears it. Existing users default to false (no forced change).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;
-- +goose StatementEnd
