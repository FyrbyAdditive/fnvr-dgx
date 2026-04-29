# NATS subjects

Everything fanning out from the pipeline or needing cross-service delivery goes through NATS. Subjects + who reads/writes them:

## `fnvr.events.detection.<camera_id>`

- **Producer:** pipeline probe after the primary detector + tracker.
- **Consumer:** event-processor only (runs rules, suppression, face match, INSERT; then republishes on the *accepted* subject below).
- **Not consumed by api-server or notification-dispatcher any more.** Those used to subscribe here directly, but that bypassed object-flag suppression so a user-flagged truck still appeared on the Live view. They now subscribe to `fnvr.events.detection_accepted.<camera_id>` instead.
- **Payload** ([apps/event-processor/internal/rules/engine.go](../../apps/event-processor/internal/rules/engine.go) `Detection` struct):

```json
{
  "id": "<pipeline-event-uuid>",
  "camera_id": "house-back",
  "ts": "2026-04-21T09:41:02.312Z",
  "class_name": "person",
  "kind": "object",
  "confidence": 0.74,
  "bbox": { "x": 0.42, "y": 0.31, "w": 0.08, "h": 0.22 },
  "track_id": "7",
  "attributes": {
    "plate": "AB12CDE",          // only on kind=anpr
    "plate_conf": "0.93",
    "embedding": "<base64-512*f32>", // only on kind=face, stripped after match
    "person": "tim",             // set by event-processor on accept
    "person_id": "<uuid>",
    "similarity": "0.421"
  }
}
```

Non-face detections publish `attributes` as a small string map (plate / plate_conf / color / etc.). Face detections carry the raw embedding until the matcher resolves (or doesn't) the match, at which point `attributes.embedding` is replaced by `embedding_hash` for dedup.

## `fnvr.events.detection_accepted.<camera_id>`

- **Producer:** event-processor, after suppression + mutes + face-match enrichment + PG INSERT.
- **Consumers:** api-server's SSE bus (feeds the Live page + Events tab); notification-dispatcher's Home Assistant bridge.
- **Payload:** same fields as the raw `detection` subject plus `pg_id` (int64, the `detections.id` row that was just written) so web clients can build `POST /api/v1/detections/<pg_id>/flag` URLs without a second round-trip to resolve `event_id → id`.

Why a separate subject: api-server used to consume the raw pipeline subject directly, which meant object-flag suppression (which happens in event-processor) didn't apply to the SSE stream — a user's flagged truck still appeared on Live. Republishing on an "accepted" subject keeps suppression authoritative while letting the pipeline stay DB-stateless.

## `fnvr.events.incident.<camera_id>`

- **Producer:** event-processor, from one of five fire paths — rule, hotlist, face-match, drift, sequence.
- **Consumer:** notification-dispatcher.
- **Special subject `fnvr.events.incident.__system`** for system-scope incidents (`camera_id=NULL` in DB). The dispatcher's wildcard subscription (`fnvr.events.incident.>`) catches it; per-camera subscribers skip it via the SQL match (see [architecture/notifications.md](../architecture/notifications.md)).

Payload:

```json
{
  "id": "<uuid>",
  "rule_id": "<uuid|null>",
  "camera_id": "house-back",
  "started_at": "2026-04-21T09:41:02.312Z",
  "severity": "warning",
  "summary": "person on house-back (74%)",
  "rule_kind": "object|sequence|hotlist|face|drift"
}
```

Extra fields by kind:
- `hotlist` — adds `hotlist_id`, `plate`.
- `face` — adds `person_id`, `person`, `similarity`.
- `drift` — adds `baseline`, `current`, `delta`; `camera_id` is the empty string.

## `fnvr.state.camera.<camera_id>` (JetStream last-value)

- **Producer:** pipeline worker; 30 s heartbeat while `running`, plus the one-off `starting` before pipeline PLAY and `failed` on fault.
- **Consumer:** api-server's [camera/state.go](../../apps/api-server/internal/camera/state.go) `StateTracker` — subscribes with `DeliverAllPolicy` on a stream with `MaxMsgsPerSubject=1`, so an api-server restart replays the latest per-camera state immediately.
- **Payload:** `{camera_id, state}` where `state ∈ starting | running | failed`.
- **Stream config:** `FNVR_CAMERA_STATE`, MemoryStorage, 1 msg per subject, DiscardOld.

Freshness windows applied by the tracker (not by the stream):
- `running`: 10 min.
- `starting`: 15 min (TRT compiles can take that long).
- other: 2 min.

Past the window, the tracker returns `unknown`, though `StateDetail()` still returns the stamped time so the UI can show "last heartbeat Nm ago".

## `fnvr.state.pipeline`

- **Producer:** pipeline-supervisor (parent), one-off on startup.
- **Consumer:** api-server, `pipeline.StateTracker`.
- **Payload:** `{state}` — parent-process-level. Used by Layout.tsx's banner during TRT engine compiles.

## `fnvr.alerts.drift`

- **Producer:** ml-worker `drift.py` when `baseline - current >= 0.05`.
- **Consumer:** event-processor → `fireDriftIncident`.
- **Payload:** `{at, current, baseline, delta}`.

## `fnvr.models.faceid.reload`

- **Producer:** ml-worker's `tao_stub.promote_model()` after an atomic swap of `arcface.onnx`.
- **Consumer:** pipeline (when wired — currently a no-op since TAO training isn't shipped).
- **Payload:** `{}`.

## Connection naming

Services set `nats.Name("fnvr-<service>[-<role>]")` so the NATS monitor (`http://nats:8222/connz`) clearly shows who's who. The pipeline's nats-c client doesn't set a name — those show as "(no name)" in connz. Not a bug, just a client-library gap.

## What's NOT on NATS

- **HTTP requests from the web.** Go via api-server, Postgres + the event bus, not NATS.
- **WebRTC live + fMP4 playback.** Browser talks directly to MediaMTX on `:8889/whep` and `:9996/get`; api-server isn't in the media path at all.
- **Recordings.** Written by MediaMTX's built-in recorder; no NATS event per written frame.
