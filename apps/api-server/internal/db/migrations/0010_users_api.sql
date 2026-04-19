-- +goose Up
-- +goose StatementBegin

-- API-only users can't log in via the browser — the login handler
-- rejects them. They authenticate exclusively via personal access
-- tokens in `Authorization: Bearer ...` headers.
ALTER TABLE users
    ADD COLUMN api_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Personal access tokens. Stored bcrypt-hashed so a DB leak doesn't
-- immediately compromise active tokens. Revoked by deleting the row;
-- `last_used_at` is touched on each auth hit for operator audit.
CREATE TABLE api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS api_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS api_only;
-- +goose StatementEnd
