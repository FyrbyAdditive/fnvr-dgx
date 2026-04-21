-- +goose Up
-- +goose StatementBegin

-- Unknown-face clustering: a cluster is a group of similar face
-- embeddings (same person, probably not yet enrolled). Produced by
-- the ml-worker's HDBSCAN batch job nightly and on-demand.
--
-- enrolled_person_id is set when an operator names a whole cluster
-- from the Faces tab — clicking "Enrol as Alice" copies every
-- member embedding into face_embeddings with source="cluster-..."
-- and points the cluster row at Alice. Subsequent matcher reloads
-- pick up those embeddings and future detections of Alice match
-- without any further operator action.
CREATE TABLE face_clusters (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Mean of all member embeddings, re-computed on each batch run.
    -- Used by the batch job to preserve cluster IDs across runs: new
    -- batches look up each candidate cluster's centroid against this
    -- table and reuse the existing id if cosine ≥ 0.6.
    centroid                    vector(512) NOT NULL,
    member_count                INTEGER NOT NULL DEFAULT 0,
    -- The highest-confidence member detection, used as the cluster's
    -- representative thumbnail in the UI grid.
    representative_detection_id BIGINT,
    -- 'hdbscan' today, 'manual' reserved for operator-created
    -- groupings from future UI work.
    algorithm                   TEXT NOT NULL DEFAULT 'hdbscan'
        CHECK (algorithm IN ('hdbscan', 'manual')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Null until an operator enrols the cluster. SET NULL on person
    -- delete so erasure doesn't destroy cluster history — the
    -- cluster just becomes "unenrolled again".
    enrolled_person_id          UUID REFERENCES persons(id) ON DELETE SET NULL
);
-- ivfflat keeps centroid lookups cheap at small-to-medium scale
-- (expect ≤ a few thousand clusters). lists=50 tuned for that.
CREATE INDEX face_clusters_centroid_idx
    ON face_clusters
    USING ivfflat (centroid vector_cosine_ops)
    WITH (lists = 50);

-- Per-cluster member list. detection_id is the PG row it came from.
-- Embedding is duplicated from detections.attributes so the batch
-- job can read everything in one query without JSONB decode.
CREATE TABLE face_cluster_members (
    cluster_id             UUID NOT NULL REFERENCES face_clusters(id) ON DELETE CASCADE,
    detection_id           BIGINT NOT NULL,
    embedding              vector(512) NOT NULL,
    similarity_to_centroid REAL,
    added_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cluster_id, detection_id)
);
CREATE INDEX face_cluster_members_detection_idx
    ON face_cluster_members (detection_id);

-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS face_cluster_members;
DROP INDEX IF EXISTS face_clusters_centroid_idx;
DROP TABLE IF EXISTS face_clusters;
-- +goose StatementEnd
