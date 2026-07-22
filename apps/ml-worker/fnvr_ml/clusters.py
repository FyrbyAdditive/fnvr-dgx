"""Unknown-face clustering via HDBSCAN.

Two public entry points:
- hdbscan_labels(embeddings, min_cluster_size) → per-row label
- batch_cluster_unmatched() → scan recent unmatched face
  detections, cluster them, persist into face_clusters +
  face_cluster_members. Idempotent and reuses existing cluster
  IDs whose centroid is nearby (cosine ≥ 0.6) so a re-run
  extends last night's clusters rather than making new ones.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import struct
from datetime import datetime, timezone
from typing import Any, Iterable

import hdbscan
import numpy as np
import psycopg

log = logging.getLogger(__name__)

_DATABASE_URL = os.environ.get(
    "FNVR_DATABASE_URL",
    "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable",
)
# Max lookback for unmatched detections. A week is enough to surface
# recurring strangers without drowning in noise; anything older
# hasn't been re-seen recently.
_LOOKBACK_HOURS = 24 * 7
# Centroid-match threshold for reusing an existing cluster across
# batch runs. 0.6 picks up clear "same person, new batch" without
# merging distinct identities; ArcFace same-identity cosine usually
# > 0.5 on well-lit frames.
_CLUSTER_MATCH = 0.6
# Only cluster embeddings from the current (aligned) space — must
# match fnvr_ml.inference.EMBEDDING_MODEL (kept literal so this module
# stays importable without pulling onnxruntime).
_EMBEDDING_MODEL = "topofr_r100"


def _decode_embedding_b64(b64: str) -> np.ndarray | None:
    """Decode the base64'd little-endian float32 vector the pipeline
    stores on detections.attributes['embedding']."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        return None
    if len(raw) != 512 * 4:
        return None
    vec = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    # Re-normalise defensively. The pipeline already does this but
    # base64 round-trip never loses precision, so it's cheap.
    n = float(np.linalg.norm(vec))
    if n < 1e-12:
        return None
    return vec / n


def _vec_literal(v: np.ndarray | Iterable[float]) -> str:
    """pgvector text format '[v0,v1,...]'. Matches the helper in
    apps/api-server/internal/persons/store.go."""
    arr = np.asarray(v, dtype=np.float32)
    return "[" + ",".join(f"{x:.6g}" for x in arr.tolist()) + "]"


def _parse_vec_text(s: str) -> np.ndarray:
    s = s.strip()
    if not (s.startswith("[") and s.endswith("]")):
        raise ValueError("bad vector literal")
    parts = s[1:-1].split(",")
    return np.asarray([float(p) for p in parts], dtype=np.float32)


def _get_min_cluster_size(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT value FROM settings WHERE key = %s",
            ("ml.cluster.min_cluster_size",),
        )
        row = cur.fetchone()
    if row is None:
        return 3
    try:
        return int(json.loads(row[0]))
    except Exception:
        return 3


def hdbscan_labels(
    embeddings: np.ndarray,
    min_cluster_size: int = 3,
) -> np.ndarray:
    """Run HDBSCAN on L2-normalised embeddings.

    We use euclidean distance on L2-normed vectors which is
    monotonically equivalent to cosine distance (cheaper to compute
    and supported natively by hdbscan). min_samples=1 so a single
    strong anchor can form a cluster with its neighbours.
    """
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=max(2, int(min_cluster_size)),
        min_samples=1,
        metric="euclidean",
        cluster_selection_method="eom",
    )
    return clusterer.fit_predict(embeddings.astype(np.float32))


def batch_cluster_unmatched() -> dict[str, Any]:
    """Pull recent unmatched face detections, cluster them, persist.

    Returns a report {candidates_scanned, clusters_written,
    members_written, preserved_clusters, new_clusters}.
    """
    started = datetime.now(timezone.utc)
    with psycopg.connect(_DATABASE_URL, autocommit=False) as conn:
        min_cs = _get_min_cluster_size(conn)
        with conn.cursor() as cur:
            # Only face detections that never matched a person and
            # still carry an embedding. attributes->>'person_id'
            # absent (null) is the unmatched signal; ml-worker's face
            # consumer writes the base64 embedding + embedding_model
            # into attributes. The model filter keeps old-space
            # (unaligned adaface, no tag) rows out — cross-space
            # cosines are garbage and would poison clusters during
            # the transition window.
            cur.execute(
                """
                SELECT id, attributes->>'embedding'
                FROM detections
                WHERE kind = 'face'
                  AND ts > NOW() - (%s::int || ' hours')::interval
                  AND (attributes->>'person_id') IS NULL
                  AND (attributes->>'embedding') IS NOT NULL
                  AND (attributes->>'embedding_model') = %s
                ORDER BY ts DESC
                LIMIT 50000
                """,
                (_LOOKBACK_HOURS, _EMBEDDING_MODEL),
            )
            rows = cur.fetchall()

        detection_ids: list[int] = []
        vecs: list[np.ndarray] = []
        for det_id, emb_b64 in rows:
            v = _decode_embedding_b64(emb_b64 or "")
            if v is None:
                continue
            detection_ids.append(int(det_id))
            vecs.append(v)

        report: dict[str, Any] = {
            "candidates_scanned": len(rows),
            "decoded": len(vecs),
            "clusters_written": 0,
            "members_written": 0,
            "preserved_clusters": 0,
            "new_clusters": 0,
            "noise": 0,
        }
        if len(vecs) < min_cs:
            log.info("not enough unmatched faces to cluster: %d", len(vecs))
            return report

        mat = np.stack(vecs)
        labels = hdbscan_labels(mat, min_cluster_size=min_cs)
        report["noise"] = int((labels == -1).sum())

        # Load existing clusters so we can try to reuse ids.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id::text, centroid::text FROM face_clusters "
                "WHERE enrolled_person_id IS NULL"
            )
            existing = []
            for cid, cvec in cur.fetchall():
                try:
                    existing.append((cid, _parse_vec_text(cvec)))
                except Exception:
                    continue

        # Nuke prior membership for clusters we're about to rewrite.
        # We don't delete clusters — we upsert-by-centroid so ids are
        # stable across runs. Members are per-batch, so safest to
        # rebuild them.
        with conn.cursor() as cur:
            # Re-run wipes ONLY unenrolled clusters. Enrolled clusters
            # are frozen — their member list shouldn't change because
            # the operator has already claimed them for a person.
            cur.execute(
                "DELETE FROM face_cluster_members WHERE cluster_id IN "
                "(SELECT id FROM face_clusters WHERE enrolled_person_id IS NULL)"
            )

        unique_labels = sorted({int(l) for l in labels if l != -1})
        now = datetime.now(timezone.utc)
        for lab in unique_labels:
            idx = np.where(labels == lab)[0]
            member_vecs = mat[idx]
            centroid = member_vecs.mean(axis=0)
            centroid = centroid / max(float(np.linalg.norm(centroid)), 1e-12)
            # Find an existing unenrolled cluster whose centroid is
            # within _CLUSTER_MATCH cosine; reuse its id. Otherwise
            # insert a new row.
            best_id: str | None = None
            best_j = -1
            best_sim = -1.0
            for j, (cid, cvec) in enumerate(existing):
                sim = float(np.dot(centroid, cvec))
                if sim > best_sim:
                    best_sim = sim
                    best_id = cid
                    best_j = j
            with conn.cursor() as cur:
                rep_det = int(detection_ids[idx[0]])
                if best_id is not None and best_sim >= _CLUSTER_MATCH:
                    cur.execute(
                        """
                        UPDATE face_clusters
                        SET centroid = %s::vector,
                            member_count = %s,
                            representative_detection_id = %s,
                            updated_at = %s
                        WHERE id = %s
                        """,
                        (
                            _vec_literal(centroid),
                            int(len(idx)),
                            rep_det,
                            now,
                            best_id,
                        ),
                    )
                    cluster_uuid = best_id
                    # Claimed: remove from the candidate pool so a
                    # second label this batch can't also claim it and
                    # silently merge two distinct clusters.
                    existing.pop(best_j)
                    report["preserved_clusters"] += 1
                else:
                    cur.execute(
                        """
                        INSERT INTO face_clusters
                            (centroid, member_count,
                             representative_detection_id, algorithm)
                        VALUES (%s::vector, %s, %s, 'hdbscan')
                        RETURNING id::text
                        """,
                        (_vec_literal(centroid), int(len(idx)), rep_det),
                    )
                    cluster_uuid = cur.fetchone()[0]  # type: ignore[index]
                    report["new_clusters"] += 1

                # Bulk insert members via COPY — one stream instead of
                # a round-trip per row (matters at 50k members). One
                # matmul computes every member's similarity. Conflicts
                # are impossible here: membership was wiped above,
                # each cluster is claimed at most once per run, and
                # detection_ids are unique within a batch.
                sims = mat[idx] @ centroid
                with cur.copy(
                    "COPY face_cluster_members "
                    "(cluster_id, detection_id, embedding, "
                    "similarity_to_centroid) FROM STDIN"
                ) as cp:
                    for j, i in enumerate(idx):
                        cp.write_row(
                            (
                                cluster_uuid,
                                int(detection_ids[i]),
                                _vec_literal(mat[i]),
                                float(sims[j]),
                            )
                        )
                report["members_written"] += len(idx)
            report["clusters_written"] += 1

        # Prune any unenrolled cluster that now has zero members
        # (e.g. all its old members aged past the lookback).
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM face_clusters fc
                WHERE fc.enrolled_person_id IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM face_cluster_members m
                    WHERE m.cluster_id = fc.id
                  )
                """
            )
        conn.commit()

    took = (datetime.now(timezone.utc) - started).total_seconds()
    report["took_seconds"] = round(took, 3)
    log.info("batch_cluster report: %s", report)
    return report
