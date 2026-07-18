-- +goose Up
-- +goose StatementBegin

-- 2026 aligned face stack (docs/architecture/face-id.md): SCRFD-10G
-- detector + ArcFace-aligned crops + TopoFR R100 embedder, embedding
-- moved out of the DeepStream graph into ml-worker. Aligned TopoFR
-- embeddings are a new space, tagged model='topofr_r100' by code.

-- Dismissal negatives are embeddings too — they must carry a space
-- tag or the negative veto compares cross-space (garbage cosines that
-- can veto every genuine match; found the hard way with the
-- unfiltered-negatives bug). Existing rows are old-space.
ALTER TABLE face_dismissals
    ADD COLUMN model TEXT NOT NULL DEFAULT 'adaface_ir101';

-- New enrolments/dismissals write 'topofr_r100' explicitly; move the
-- face_embeddings column default forward too so any missed insert
-- path can't silently tag rows with the 2025 default.
ALTER TABLE face_embeddings
    ALTER COLUMN model SET DEFAULT 'topofr_r100';

-- Aligned same-person cosines land 0.65-0.8 (measured; unaligned was
-- 0.45-0.58) — move the operator threshold to the new space's default.
UPDATE settings SET value = '0.55', updated_at = NOW()
WHERE key = 'faces.match_threshold';

-- Unenrolled clusters were built from old-space embeddings — flush
-- them; the nightly job rebuilds from new-space detections. Enrolled
-- clusters keep their rows (history), they just stop mattering.
DELETE FROM face_cluster_members
WHERE cluster_id IN (SELECT id FROM face_clusters WHERE enrolled_person_id IS NULL);
DELETE FROM face_clusters WHERE enrolled_person_id IS NULL;

-- Drift baseline was measured in the old space — clear it so the
-- first new-space run re-seeds instead of "detecting" fake drift.
UPDATE settings SET value = 'null', updated_at = NOW()
WHERE key = 'ml.drift.baseline_self_match';

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
ALTER TABLE face_dismissals DROP COLUMN IF EXISTS model;
ALTER TABLE face_embeddings ALTER COLUMN model SET DEFAULT 'arcface_r100';
UPDATE settings SET value = '0.40', updated_at = NOW()
WHERE key = 'faces.match_threshold';
-- +goose StatementEnd
