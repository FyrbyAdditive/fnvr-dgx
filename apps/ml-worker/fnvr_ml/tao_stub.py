"""Scaffolding for future TAO fine-tune of the ArcFace embedder.

This file is deliberately unwired today. It holds:

- promote_model() — atomic swap of /var/lib/fnvr/models/faceid/
  arcface.onnx, plus a NATS publish so the pipeline reloads.
- shadow_mode_runner() — subscribes fnvr.events.detection.* and
  runs a candidate embedder alongside production, stashing per-
  detection delta metrics into fine_tune_jobs.metrics.

Actual training is NOT implemented here. The recipe (when TAO
Toolkit lands on the host):

    1. harvest labelled embeddings:
         - positives: face_embeddings (per person)
         - negatives: face_dismissals where reason='not_a_face'
         - ambiguous: faces close to decision boundary
    2. build a TAO spec for ArcFace fine-tune on this dataset.
    3. run TAO container (requires GPU on the training box).
    4. export the resulting weights to ONNX.
    5. mark a new row in fine_tune_jobs (state=shadow), stash
       onnx_path; call shadow_mode_runner() for a week.
    6. when shadow metrics look good, call promote_model() and
       flip the row to state=promoted.

See docs/deployment/fine-tune.md for the full plan once it lands.

Until that's wired, the code below is documentation-with-types
— importable but inert.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_MODELS_DIR = Path(os.environ.get("FNVR_MODELS_DIR", "/var/lib/fnvr/models/faceid"))
_ARCFACE_LIVE = _MODELS_DIR / "arcface.onnx"
_BACKUP_DIR = _MODELS_DIR / "backups"


def promote_model(new_onnx_path: str | os.PathLike[str]) -> dict[str, Any]:
    """Atomically swap the production arcface.onnx, keep a backup,
    and publish fnvr.models.faceid.reload so the pipeline rebuilds
    its engine on next worker start.

    Not called anywhere today. Scaffolding for the future fine-tune
    pipeline. Returns {backup_path, promoted_path}.
    """
    src = Path(new_onnx_path).resolve()
    if not src.is_file():
        raise FileNotFoundError(src)
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # Backup the currently-live weights so we can roll back.
    stamp = _timestamp()
    backup_path = _BACKUP_DIR / f"arcface.{stamp}.onnx"
    if _ARCFACE_LIVE.exists():
        shutil.copy2(_ARCFACE_LIVE, backup_path)

    # Atomic rename into place (same filesystem required; the
    # models dir is always on the fnvr-data volume).
    tmp = _ARCFACE_LIVE.with_suffix(".onnx.tmp")
    shutil.copy2(src, tmp)
    os.replace(tmp, _ARCFACE_LIVE)
    log.info("promoted %s -> %s (backup %s)", src, _ARCFACE_LIVE, backup_path)

    _publish_reload()
    return {
        "promoted_path": str(_ARCFACE_LIVE),
        "backup_path": str(backup_path),
    }


def shadow_mode_runner(job_id: str, candidate_onnx: str) -> None:
    """Placeholder. A real implementation would:

    * load `candidate_onnx` via onnxruntime (same CPU provider as
      inference.py),
    * subscribe NATS `fnvr.events.detection.*` with kind=face,
    * for each detection re-embed the cropped face (if available)
      using the candidate and compute cosine vs production's
      embedding,
    * aggregate the deltas (mean, p50, p95) and write them to
      fine_tune_jobs.metrics by job_id.
    """
    raise NotImplementedError(
        "shadow_mode_runner is scaffolding; wire up when the TAO "
        "fine-tune slice lands."
    )


def _publish_reload() -> None:
    try:
        import asyncio
        import nats

        nats_url = os.environ.get("FNVR_NATS_URL", "nats://nats:4222")

        async def _go():
            nc = await nats.connect(nats_url, name="fnvr-ml-worker")
            try:
                await nc.publish(
                    "fnvr.models.faceid.reload", b"{}"
                )
                await nc.flush(timeout=2)
            finally:
                await nc.drain()

        asyncio.run(_go())
    except Exception as e:
        log.warning("reload publish failed: %s", e)


def _timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
