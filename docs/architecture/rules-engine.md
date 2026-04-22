# Rules engine

The event-processor ([apps/event-processor/internal/rules/engine.go](../../apps/event-processor/internal/rules/engine.go)) is a single Go process that:

- Consumes every `fnvr.events.detection.*` and `fnvr.alerts.drift` message from NATS.
- Maintains an in-memory copy of rules, zones, hotlists, face enrolments, face negatives, and per-camera mutes — reloaded every 30 s from Postgres.
- Persists each detection into Postgres `detections` (attaching matched-person attributes where applicable) and into a per-segment JSONL sidecar.
- Evaluates rules against each detection and fires incidents.
- Writes system-scope incidents for drift alerts.

## Rule shape

Rules live in `rules.definition` as JSONB. Two flavours:

### Single-camera rule (default)

```json
{
  "camera_id": "house-back",   // optional — any camera if absent
  "classes":   ["person","car"],
  "min_confidence": 0.4,
  "zone_id":   "<uuid>",       // optional — polygon / line / tripwire
  "direction": "in",           // optional — only with line/tripwire zones
  "cooldown_sec": 60,
  "schedule":  { "start_minute": 1320, "end_minute": 360,
                 "days": [0,1,2,3,4,5,6] },
  "severity":  "warning"
}
```

Every detection's bbox centre is tested against the matching zones. Line/tripwire zones need the track's previous position (kept in-memory in the engine's `tracks` map) to decide on crossings.

### Cross-camera sequence rule

```json
{
  "kind": "sequence",
  "severity": "warning",
  "cooldown_sec": 60,
  "window_sec": 120,
  "steps": [
    { "camera_id": "house-back", "classes": ["car"], "min_confidence": 0.4 },
    { "camera_id": "house-side", "classes": ["car"], "min_confidence": 0.4 }
  ]
}
```

Fires a single incident the first time step N sees its match *within `window_sec` seconds of step N-1 having matched*. Slice-1 constraints:
- Per-hop `camera_id` is required.
- Optional `classes` and `min_confidence`.
- No per-hop zones / plate / face filters yet — the engine has a hook for those (see `compileSequence` in engine.go) but slice 1 doesn't use them.

Internal state: `Engine.sequenceSightings`, keyed `"<rule_id>|<step_idx>"`, with each entry pruned lazily against `d.TS - window_sec`.

## Incidents

Written to Postgres `incidents` and published on `fnvr.events.incident.<camera_id>`. Columns:

```
incidents(id uuid, rule_id uuid NULL,
          camera_id text NULL,           -- NULL for system-scope (drift)
          started_at, ended_at,
          severity text ('info'|'warning'|'critical'),
          summary text,
          detection_ids bigint[], acknowledged bool)
```

`rule_id=NULL` incidents come from hotlist hits, face matches with `alert_on_match=TRUE`, and drift alerts. The dispatcher ([notifications](notifications.md)) treats any subscription without a rule filter as matching NULL-rule incidents too.

`camera_id=NULL` is only used for drift alerts and future global ML events. The notification dispatcher's subscription matcher `(s.camera_id IS NULL OR s.camera_id = $2)` handles this correctly: un-pinned subscriptions receive system-scope incidents; camera-pinned ones skip them.

## Face match

Per-detection face matching sits inside `onDetection`, not a separate pipeline. Algorithm:

1. Decode base64 `attributes.embedding` → 512 float32s, L2-normalise.
2. Compute cosine similarity to every enrolled embedding, grouped by person.
3. For each person: sort similarities, take the **mean of the top 3** (`topK`). This is the headline score.
4. Pick the winner (highest topK).
5. Accept iff `topK >= faces.match_threshold`. If more than one person is enrolled, ALSO require `topK[winner] - topK[runner-up] >= faces.match_margin`.
6. If there are `face_dismissals` rows with `reason IN ('not_a_face','duplicate')` *and* `faces.negative_penalty_weight > 0`, compute max cosine to any negative; if `topK - weight × maxNeg < threshold`, retract the match (late veto).

On accept, the detection's `attributes` get `person`, `person_id`, `similarity` replacing the raw embedding. On reject, the embedding is kept for the enrolment UI to pick up.

Settings:
- `faces.match_threshold` — default 0.40, recommended 0.32 with top-K.
- `faces.match_margin` — default 0.05.
- `faces.negative_penalty_weight` — default 1.0. 0 disables negatives.

See [operations/face-id.md](../operations/face-id.md) for tuning advice.

## Object-flag suppression

False-positive object detections flagged via the Live UI's bbox click
(see [operations/false-positive-flags.md](../operations/false-positive-flags.md))
feed a per-`(camera, class)` pHash library. Every object detection is
checked against it BEFORE rule evaluation, incident firing, or even
persistence — suppressed detections leave no trace.

The pipeline emits a 64-bit perceptual hash (`attributes.phash`,
16-char lowercase hex) for each object-kind detection. It's computed
from an 8×8 luma downsample of the bbox crop; same NvBufSurfTransform
primitive as face thumbnails.

Match algorithm: for each flag in `objectFlagsByClass[d.CameraID][d.ClassName]`,
compute `bits.OnesCount64(probe ^ flag)`. Distance ≤
`detections.suppression_hamming_threshold` (default 8) → suppress.

Effects of suppression:
- Detection is not INSERTed into `detections`.
- Not added to the per-segment JSONL sidecar.
- Not evaluated against rules.
- Not republished on `fnvr.events.detection_accepted.<camera_id>`, which is what the SSE bus + the HA bridge consume — so suppressed detections don't reach the Live view, Events tab, or Home Assistant.
- Counted as `fnvr_detections_suppressed_total{camera_id, class}`.

Split-subject detail: the pipeline publishes every frame on `fnvr.events.detection.<camera_id>`; only event-processor subscribes there. After passing suppression + mutes + face-match + INSERT, event-processor republishes on `fnvr.events.detection_accepted.<camera_id>`, and every downstream consumer (api-server SSE, HA bridge) subscribes there instead. Keeps the pipeline DB-stateless while still letting suppression be authoritative for the UI.

The library is loaded in `reload()` (30 s cadence), same shape as face
negatives. Soft-deleting a flag via the Flags page removes it from the
library within ≤ 30 s.

Settings:
- `detections.suppression_hamming_threshold` — default 8, clamped to
  [4, 16]. Smaller = tighter match, fewer false suppressions, more
  missed suppressions. See [operations/settings.md](../operations/settings.md).

## Plate hotlist

`plate_hotlist` rows hold `pattern` (SQL LIKE-shape, uppercase alphanumerics + `%`), `label`, `severity`. Every ANPR detection's normalised plate is checked; matches fire an incident with `rule_id=NULL`, severity from the entry, summary `"hotlist: <label> (<plate>) on <camera>"`. Cooldown is 30 s keyed on `"hotlist:<entry_id>:<camera>"`.

## Drift alerts

ml-worker publishes `{at, baseline, current, delta}` to `fnvr.alerts.drift` when its weekly self-match check sees ≥5 % drop. `fireDriftIncident`:
- 24 h cooldown on `"drift:global"`.
- `rule_id=NULL`, `camera_id=NULL`, `severity="warning"`.
- Summary `face embedding drift: baseline X → current Y (−Z%)`.
- Publishes on the reserved `fnvr.events.incident.__system` subject so the dispatcher's wildcard picks it up.

## Reload

`reload()` runs at boot and every 30 s. It replaces the engine's in-memory state atomically under `mu.Lock()` — no per-detection DB hit, no coordination cost. Editing a rule in the UI is visible to the matcher within ≤30 s with no restart.

Observability:
- `fnvr_rules_loaded` gauge (current rules count).
- `fnvr_enrolled_embeddings` gauge.
- `fnvr_face_negatives` gauge.
- `fnvr_reload_duration_seconds` histogram.
- `fnvr_detections_processed_total{camera_id, kind}`.
- `fnvr_incidents_fired_total{severity, rule_kind}` — `rule_kind ∈ {object, sequence, hotlist, face, drift}`.
