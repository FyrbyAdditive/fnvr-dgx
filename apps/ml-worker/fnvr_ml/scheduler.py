"""APScheduler cron: nightly batch clustering + weekly drift check.

Both jobs are also exposed as HTTP endpoints so the operator can
trigger them on-demand from the Settings / Faces UI. The cron here
is the unattended path for production.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
import psycopg

from . import clusters as cluster_ops
from . import drift as drift_ops

log = logging.getLogger(__name__)

_DATABASE_URL = os.environ.get(
    "FNVR_DATABASE_URL",
    "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable",
)
_TZ = os.environ.get("FNVR_TZ", "Europe/London")

_scheduler: BackgroundScheduler | None = None


def _parse_hhmm(s: str, default_hour: int, default_minute: int) -> tuple[int, int]:
    try:
        parts = s.split(":")
        return int(parts[0]), int(parts[1])
    except Exception:
        return default_hour, default_minute


def _read_setting(conn: psycopg.Connection, key: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
        row = cur.fetchone()
    if row is None:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def _write_setting(conn: psycopg.Connection, key: str, value: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE settings SET value = %s WHERE key = %s",
            (json.dumps(value), key),
        )
    conn.commit()


def _run_batch_cluster() -> None:
    """Wraps cluster_ops.batch_cluster_unmatched with status
    reporting into the settings table so the UI can show
    last_run_state / last_run_error."""
    try:
        with psycopg.connect(_DATABASE_URL) as conn:
            _write_setting(conn, "ml.cluster.last_run_state", "running")
            _write_setting(conn, "ml.cluster.last_run_error", None)
        report = cluster_ops.batch_cluster_unmatched()
        with psycopg.connect(_DATABASE_URL) as conn:
            _write_setting(
                conn,
                "ml.cluster.last_run_state",
                {
                    "state": "ok",
                    "at": datetime.now(timezone.utc).isoformat(),
                    **report,
                },
            )
    except Exception as e:
        log.exception("scheduled batch cluster failed")
        try:
            with psycopg.connect(_DATABASE_URL) as conn:
                _write_setting(
                    conn,
                    "ml.cluster.last_run_state",
                    {
                        "state": "error",
                        "at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                _write_setting(
                    conn, "ml.cluster.last_run_error", str(e)
                )
        except Exception:
            pass


def _run_drift() -> None:
    try:
        drift_ops.check()
    except Exception:
        log.exception("scheduled drift check failed")


def start() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    schedule_str = "03:00"
    try:
        with psycopg.connect(_DATABASE_URL) as conn:
            v = _read_setting(conn, "ml.cluster.batch_schedule")
            if isinstance(v, str):
                schedule_str = v
    except Exception:
        # Falls back to default schedule. Usually means postgres
        # isn't ready yet; the cron will still fire once PG is up.
        pass
    hh, mm = _parse_hhmm(schedule_str, 3, 0)

    sched = BackgroundScheduler(timezone=_TZ)
    # Nightly cluster batch at HH:MM local time.
    sched.add_job(
        _run_batch_cluster,
        "cron",
        hour=hh,
        minute=mm,
        id="nightly_batch_cluster",
        coalesce=True,
        max_instances=1,
    )
    # Weekly drift check — Monday at HH+1:00 so the cluster run
    # isn't fighting for DB connections.
    sched.add_job(
        _run_drift,
        "cron",
        day_of_week="mon",
        hour=(hh + 1) % 24,
        minute=mm,
        id="weekly_drift_check",
        coalesce=True,
        max_instances=1,
    )
    sched.start()
    _scheduler = sched
    log.info(
        "scheduler started — nightly cluster at %02d:%02d (%s), "
        "weekly drift Mon %02d:%02d",
        hh,
        mm,
        _TZ,
        (hh + 1) % 24,
        mm,
    )


def stop() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
