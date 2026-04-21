# notification-dispatcher

Go service. Subscribes to `fnvr.events.incident.>` and fans each incident out to matching subscribers.

Channel kinds shipped:

- **webhook** — HTTP POST with retry + exponential backoff.
- **ntfy** — ntfy.sh or self-hosted topic with configurable headers for title/priority/tags.
- **mqtt** — publish to a broker with `{camera_id}`/`{severity}`/`{rule_id}` topic templating.
- **Home Assistant bridge** — publishes MQTT discovery messages and per-camera state topics.

Deferred (no user account / no hardware):

- Telegram, Signal, email, push (FCM/APNs/Web Push), SIP call, GPIO relay, SNMP.

Design + wire format in [docs/architecture/notifications.md](../../docs/architecture/notifications.md).

## Key detail: NULL-friendly matching

`(s.rule_id IS NULL OR s.rule_id::text = $1) AND (s.camera_id IS NULL OR s.camera_id = $2)` — unpinned subscriptions catch rule-less incidents (hotlist, face, drift) and system-scope incidents. Per-camera-pinned subscriptions correctly skip system-scope ones.
