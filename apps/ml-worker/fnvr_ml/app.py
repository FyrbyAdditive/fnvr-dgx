"""FastAPI surface for the ml-worker sidecar.

Endpoints:
- GET  /healthz             — liveness
- POST /detect-and-embed    — one JPEG → list of faces + embeddings
- POST /cluster             — embeddings → HDBSCAN labels
- POST /batch-cluster       — idempotent nightly/on-demand job:
                              pull unmatched face detections from
                              PG, cluster, upsert face_clusters
                              and face_cluster_members.
- POST /drift-check         — compute self-match stats on enrolled
                              embeddings and publish NATS drift
                              alert if degraded.

Nothing here is auth'd — the container is docker-internal only,
no published port. api-server is the only client.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel, Field

from . import clusters as cluster_ops
from . import drift as drift_ops
from . import inference
from . import scheduler as sched

logging.basicConfig(
    level=os.environ.get("FNVR_ML_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Start APScheduler on startup, stop it cleanly on shutdown.
    sched.start()
    log.info("ml-worker ready")
    try:
        yield
    finally:
        sched.stop()


app = FastAPI(title="fnvr ml-worker", lifespan=_lifespan)


# --- /healthz -------------------------------------------------------

@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"status": "ok"}


# --- /detect-and-embed ---------------------------------------------

@app.post("/detect-and-embed")
async def detect_and_embed(
    file: UploadFile = File(...),
) -> dict[str, Any]:
    jpg = await file.read()
    if not jpg:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(jpg) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="file too large (>10MB)")
    try:
        results = inference.detect_and_embed(jpg)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        log.exception("detect_and_embed failed")
        raise HTTPException(status_code=500, detail=f"inference failed: {e!s}")
    return {
        "faces": [
            {
                "bbox": {"x": f.x, "y": f.y, "w": f.w, "h": f.h},
                "score": f.score,
                "embedding": f.embedding,
            }
            for f in results
        ]
    }


# --- /cluster -------------------------------------------------------

class ClusterRequest(BaseModel):
    embeddings: list[list[float]]
    min_cluster_size: int = Field(default=3, ge=2, le=50)


@app.post("/cluster")
async def cluster(req: ClusterRequest) -> dict[str, Any]:
    if len(req.embeddings) < req.min_cluster_size:
        # Nothing to cluster — return all-noise.
        return {"labels": [-1] * len(req.embeddings)}
    try:
        labels = cluster_ops.hdbscan_labels(
            np.asarray(req.embeddings, dtype=np.float32),
            min_cluster_size=req.min_cluster_size,
        )
    except Exception as e:
        log.exception("cluster failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"labels": [int(x) for x in labels]}


# --- /batch-cluster -------------------------------------------------

@app.post("/batch-cluster")
async def batch_cluster() -> dict[str, Any]:
    try:
        report = cluster_ops.batch_cluster_unmatched()
    except Exception as e:
        log.exception("batch_cluster failed")
        raise HTTPException(status_code=500, detail=str(e))
    return report


# --- /drift-check ---------------------------------------------------

@app.post("/drift-check")
async def drift_check() -> dict[str, Any]:
    try:
        report = drift_ops.check()
    except Exception as e:
        log.exception("drift_check failed")
        raise HTTPException(status_code=500, detail=str(e))
    return report
