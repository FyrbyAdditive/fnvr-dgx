"""One-shot re-embedding of enrolled samples into the aligned space.

Old rows (model='adaface_ir101') were embedded from UNALIGNED crops —
they are a different, worse space than the aligned TopoFR embeddings
the system now produces, and the matcher only loads the new tag. This
job re-embeds each enrolled sample from its saved source image and
inserts a NEW row tagged with the new model; old rows are kept so a
rollback is a pure image revert.

Source images: detection-sourced embeddings have
/var/lib/fnvr/thumbs/faces/{detection_id}.jpg (the 1.4x-expanded
256x256 crop); upload-sourced ones have thumbs/faces/{source}.jpg.
Landmarks are re-detected on the image (SCRFD), centre face picked —
same path live faces take, so migrated and live embeddings agree.

Idempotent: (person_id, source) pairs that already have a new-tag row
are skipped. Samples with no on-disk image are reported for manual
re-enrolment.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import cv2
import psycopg

from . import align, inference, scrfd

log = logging.getLogger(__name__)

_DATABASE_URL = os.environ.get(
    "FNVR_DATABASE_URL",
    "postgres://fnvr:fnvr@postgres:5432/fnvr",
)
_THUMBS_DIR = os.environ.get("FNVR_FACE_THUMBS_DIR", "/var/lib/fnvr/thumbs/faces")
_OLD_MODEL = "adaface_ir101"


def _vec_literal(vec) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def _source_image_path(source: str, detection_id: int | None) -> str | None:
    if detection_id and detection_id > 0:
        p = os.path.join(_THUMBS_DIR, f"{detection_id}.jpg")
        if os.path.exists(p):
            return p
    if source.startswith("upload-"):
        p = os.path.join(_THUMBS_DIR, f"{source}.jpg")
        if os.path.exists(p):
            return p
    return None


def run() -> dict[str, Any]:
    migrated = 0
    failed: list[dict[str, Any]] = []
    skipped_missing: list[dict[str, Any]] = []
    already = 0

    with psycopg.connect(_DATABASE_URL, autocommit=True) as conn:
        rows = conn.execute(
            """
            SELECT e.id::text, e.person_id::text, p.label, e.source,
                   e.detection_id
            FROM face_embeddings e
            JOIN persons p ON p.id = e.person_id
            WHERE e.model = %s
            ORDER BY e.created_at
            """,
            (_OLD_MODEL,),
        ).fetchall()

        for emb_id, person_id, label, source, detection_id in rows:
            exists = conn.execute(
                """
                SELECT 1 FROM face_embeddings
                WHERE person_id = %s AND source = %s
                  AND model = %s LIMIT 1
                """,
                (person_id, source, inference.EMBEDDING_MODEL),
            ).fetchone()
            if exists:
                already += 1
                continue

            path = _source_image_path(source, detection_id)
            entry = {
                "embedding_id": emb_id,
                "person": label,
                "source": source,
            }
            if path is None:
                skipped_missing.append(entry)
                continue

            img = cv2.imread(path)
            if img is None:
                entry["reason"] = "unreadable image"
                failed.append(entry)
                continue
            h, w = img.shape[:2]
            face = scrfd.pick_center_face(scrfd.detect(img), w, h)
            if face is None:
                entry["reason"] = "no face found in source image"
                failed.append(entry)
                continue
            vec, norm, _roll, _yaw = inference.embed_face(img, face)

            conn.execute(
                """
                INSERT INTO face_embeddings
                    (person_id, embedding, source, detection_id, model)
                VALUES (%s, %s::vector, %s, %s, %s)
                """,
                (
                    person_id,
                    _vec_literal(vec),
                    source,
                    detection_id if detection_id and detection_id > 0 else None,
                    inference.EMBEDDING_MODEL,
                ),
            )
            log.info(
                "migrated %s/%s (norm %.2f)", label, source, norm
            )
            migrated += 1

    return {
        "migrated": migrated,
        "already_migrated": already,
        "skipped_missing_thumb": skipped_missing,
        "failed": failed,
    }
