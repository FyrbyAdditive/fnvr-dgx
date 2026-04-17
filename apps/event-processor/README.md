# event-processor

Go service that consumes raw detections from NATS (`fnvr.events.detection.*`) and applies the rules engine: zones, tripwires, schedules, cross-camera correlations, cooldowns, incident threading.

Emits incidents on `fnvr.events.incident.*` for `notification-dispatcher` to fan out.

Lands in M2/M3. M1 stub only.
