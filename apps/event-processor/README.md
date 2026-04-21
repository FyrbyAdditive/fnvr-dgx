# event-processor

Go service. Subscribes to `fnvr.events.detection.>` and `fnvr.alerts.drift`; applies the rules engine (zones, tripwires, schedules, cross-camera sequence rules, face match via top-K mean, hotlist, drift alerts); writes `detections` + `incidents` to Postgres; publishes incidents on `fnvr.events.incident.<camera_id>` for the notification-dispatcher.

Full rules + matcher semantics in [docs/architecture/rules-engine.md](../../docs/architecture/rules-engine.md). Face-ID specifics in [docs/architecture/face-id.md](../../docs/architecture/face-id.md).

Prometheus scrape: `:9091/metrics`. See [docs/developer/metrics.md](../../docs/developer/metrics.md).

## Where to start reading

Everything worth knowing is in one file: [internal/rules/engine.go](internal/rules/engine.go). 1500 lines, deliberately monolithic — the rules engine doesn't benefit from a package split and inline is easier to reason about.
