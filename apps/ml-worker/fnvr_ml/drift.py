"""Drift detection for the face embedder.

Weekly check: for each enrolled person with ≥2 embeddings, compute
the mean pairwise cosine similarity between their own embeddings
(self-match). Average across persons → a single scalar
`current_self_match` proxy for "how well does the embedder still
agree with itself on known-identity data".

Baseline is stored in `settings.ml.drift.baseline_self_match`. First
run writes the baseline; subsequent runs compare. Drop > 5 % →
publish NATS `fnvr.alerts.drift` so notifications land in the
existing dispatcher.

The "real" fix for drift is a fine-tune — see tao_stub.py. Until
then the alert is a flag for the operator to look at matching
quality and potentially re-enrol problem subjects.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import numpy as np
import psycopg

from . import clusters as cluster_ops  # reuse _parse_vec_text helper

log = logging.getLogger(__name__)

_DATABASE_URL = os.environ.get(
    "FNVR_DATABASE_URL",
    "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable",
)
_DRIFT_THRESHOLD = 0.05  # 5% drop triggers an alert

# NATS publish is best-effort. We import lazily so an unavailable
# nats server doesn't kill the rest of ml-worker.
def _publish_alert(payload: dict[str, Any]) -> None:
    try:
        import asyncio
        import nats

        nats_url = os.environ.get(
            "FNVR_NATS_URL", "nats://nats:4222"
        )

        async def _go():
            nc = await nats.connect(nats_url, name="fnvr-ml-worker")
            try:
                await nc.publish(
                    "fnvr.alerts.drift",
                    json.dumps(payload).encode("utf-8"),
                )
                await nc.flush(timeout=2)
            finally:
                await nc.drain()

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(_go())
        else:
            # Called from the event-loop thread (callers should route
            # check() through to_thread, but don't lose the alert if
            # one doesn't): asyncio.run would raise here, so publish
            # from a short-lived thread instead.
            import threading

            t = threading.Thread(target=lambda: asyncio.run(_go()), daemon=True)
            t.start()
            t.join(timeout=5)
    except Exception as e:
        log.warning("NATS drift alert publish failed: %s", e)


def _write_last_run(conn: psycopg.Connection, payload: dict[str, Any]) -> None:
    """Upsert ml.drift.last_run_state so the api-server can surface a
    'last checked' indicator without running the check itself.
    Unlike baseline_self_match (which is seeded by migration 0021),
    this key springs into existence the first time drift runs — no
    migration required."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value, updated_at = NOW()
                """,
                ("ml.drift.last_run_state", json.dumps(payload)),
            )
    except Exception as e:
        log.warning("drift last_run_state write failed: %s", e)


def check() -> dict[str, Any]:
    """Run one drift check. Idempotent, safe to call repeatedly."""
    now = datetime.now(timezone.utc)
    with psycopg.connect(_DATABASE_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            # Pull all enabled persons + their embeddings in one go.
            cur.execute(
                """
                SELECT p.id::text, p.label, fe.embedding::text
                FROM persons p
                JOIN face_embeddings fe ON fe.person_id = p.id
                WHERE p.enabled = TRUE
                  AND fe.model = 'topofr_r100'
                ORDER BY p.id
                """
            )
            rows = cur.fetchall()

        per_person: dict[str, list[np.ndarray]] = {}
        labels: dict[str, str] = {}
        for pid, label, vec_txt in rows:
            try:
                v = cluster_ops._parse_vec_text(vec_txt)
            except Exception:
                continue
            # Renormalise defensively; pgvector may round-trip.
            n = float(np.linalg.norm(v))
            if n < 1e-12:
                continue
            per_person.setdefault(pid, []).append(v / n)
            labels[pid] = label

        person_scores: list[float] = []
        for pid, vecs in per_person.items():
            if len(vecs) < 2:
                continue
            mat = np.stack(vecs)
            sim = mat @ mat.T  # cosine since vectors L2-normed
            # Mean of upper triangle excluding the diagonal.
            n = len(vecs)
            upper = sim[np.triu_indices(n, k=1)]
            if upper.size == 0:
                continue
            person_scores.append(float(upper.mean()))

        if not person_scores:
            report = {
                "status": "insufficient_data",
                "persons_with_multi_embedding": 0,
                "at": now.isoformat(),
            }
            log.info("drift check: %s", report)
            _write_last_run(conn, report)
            return report

        current = float(np.mean(person_scores))

        # Read + maybe seed the baseline. psycopg3 returns JSONB as a
        # parsed Python object directly (not a JSON string), so accept
        # either a raw number or a json-string-of-a-number to cover
        # old rows / future schema drift.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT value FROM settings WHERE key = %s",
                ("ml.drift.baseline_self_match",),
            )
            row = cur.fetchone()
        baseline: float | None = None
        if row is not None and row[0] is not None:
            val = row[0]
            if isinstance(val, (int, float)):
                baseline = float(val)
            elif isinstance(val, str):
                try:
                    parsed = json.loads(val)
                    if isinstance(parsed, (int, float)):
                        baseline = float(parsed)
                except Exception:
                    baseline = None

        report: dict[str, Any] = {
            "status": "ok",
            "current_self_match": round(current, 4),
            "baseline_self_match": baseline,
            "persons_with_multi_embedding": len(person_scores),
            "threshold": _DRIFT_THRESHOLD,
            "at": now.isoformat(),
        }

        if baseline is None:
            # First run — store as baseline. No alert. Upsert: the row
            # is seeded by migration 0021, but a plain UPDATE would
            # silently store nothing if it's ever absent and drift
            # alerts would never arm.
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO settings (key, value) VALUES (%s, %s) "
                    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    ("ml.drift.baseline_self_match", json.dumps(current)),
                )
            report["status"] = "baseline_set"
            log.info("drift check: baseline set to %.4f", current)
            _write_last_run(conn, report)
            return report

        delta = baseline - current
        report["delta"] = round(delta, 4)
        if delta >= _DRIFT_THRESHOLD:
            # Alert. Don't overwrite the baseline — that would
            # silently "accept" the drift on the next run.
            report["status"] = "drift_detected"
            _publish_alert(
                {
                    "at": now.isoformat(),
                    "current": current,
                    "baseline": baseline,
                    "delta": delta,
                }
            )
            log.warning(
                "drift check: delta=%.4f baseline=%.4f current=%.4f",
                delta,
                baseline,
                current,
            )
        else:
            log.info(
                "drift check: within threshold (delta=%.4f)", delta
            )
        _write_last_run(conn, report)
    return report
