-- +goose Up
-- +goose StatementBegin

-- Face embeddings are only comparable within the model that produced
-- them. The DGX retarget swaps ArcFace R100 → AdaFace IR-101; tag every
-- embedding with its model so the matcher can never score across
-- spaces (a cross-model comparison produces confident false matches —
-- the worst possible failure for face-ID).
--
-- Rows existing before this migration were ArcFace. New enrolments
-- write 'adaface_ir101'. The matcher and enrolment-pool queries filter
-- on the current model.
ALTER TABLE face_embeddings
    ADD COLUMN model TEXT NOT NULL DEFAULT 'arcface_r100';
CREATE INDEX IF NOT EXISTS face_embeddings_model_idx ON face_embeddings (model);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS face_embeddings_model_idx;
ALTER TABLE face_embeddings DROP COLUMN IF EXISTS model;
-- +goose StatementEnd
