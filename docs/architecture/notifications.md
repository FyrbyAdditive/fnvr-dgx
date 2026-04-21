# Notifications

The notification-dispatcher ([apps/notification-dispatcher/internal/channels/dispatcher.go](../../apps/notification-dispatcher/internal/channels/dispatcher.go)) is the only service that reaches out to the world. It subscribes to `fnvr.events.incident.>` and, for each message, matches it against the configured subscription rows and fans it out.

## Data model

```sql
notification_channels(id, kind, name, config JSONB, enabled)
notification_subscriptions(id, channel_id, rule_id NULL, camera_id NULL,
                           min_severity)
notification_deliveries(id, incident_id, channel_id, ts, success, detail)
```

`channels` defines the target. `subscriptions` describes *which incidents should reach which channels*. Null `rule_id` / `camera_id` on a subscription means "any rule" / "any camera" (including system-scope incidents with null camera). `min_severity` is the floor (`info` < `warning` < `critical`).

## Channel kinds (shipped)

- **webhook** — POST the incident JSON to a URL. Retries with exponential backoff; failures go to `notification_deliveries` with `success=false` and the error in `detail`.
- **ntfy** — POST to an ntfy.sh (or self-hosted) topic. `config = {base_url, topic, headers}`. Headers can carry `Title:`, `Priority:`, `Tags:` to render nicer on the mobile app.
- **mqtt** — Publish to an MQTT broker. `config = {broker, port, topic_template, ...}`. `topic_template` supports `{camera_id}`, `{severity}`, `{rule_id}` substitutions. Used by Home Assistant's MQTT discovery path + any home-automation consumer.
- **Home Assistant bridge** — Publishes MQTT discovery messages under `homeassistant/` so HA auto-creates binary sensors per camera/rule. Separately, the bridge publishes camera state topics (`fnvr/<camera>/state` etc.) so HA dashboards reflect live pipeline state.

## Dispatch path

```
incident → NATS fnvr.events.incident.<cam>  → dispatcher.handle
  → SELECT channels, min_severity
      FROM notification_channels c
      JOIN notification_subscriptions s ON s.channel_id = c.id
      WHERE c.enabled
        AND (s.rule_id IS NULL OR s.rule_id::text = $1)
        AND (s.camera_id IS NULL OR s.camera_id = $2)
  → for each row, severity gate → channel send → log delivery
```

`(s.rule_id IS NULL OR …)` is the trick that makes hotlist / face / drift incidents (all `rule_id=NULL`) reach subscriptions that weren't bound to a specific rule. Similarly `(s.camera_id IS NULL OR …)` lets system-scope drift incidents (`camera_id=NULL`) reach any subscription that isn't pinned to a specific camera.

Severity gate runs in Go rather than SQL — the three-level ordering isn't worth a PG stored function.

## Deferred channels

PLAN.md §7 also lists:
- Email, push (FCM / APNs / Web Push), Signal (via signal-cli), Telegram, SIP call, GPIO relay, SNMP.

Webhook + ntfy + MQTT cover most practical setups today (user has webhook → anything, ntfy for phone push, HA for dashboard state). Telegram and Signal are deferred because the user doesn't have accounts; SIP and GPIO need hardware integration that hasn't been prioritised.

## Subscription UX

Per-rule subscription attach is inline on each rule's row in the Rules page ([apps/web/src/routes/rules/Rules.tsx](../../apps/web/src/routes/rules/Rules.tsx) — see the `RuleRow` component). A rule with zero channels is a silent rule; useful for building + testing without spamming anyone.

Channel CRUD is on the Settings page. Send-test is per-channel: fires a synthetic `info`-severity incident through just that channel so you can confirm the webhook URL resolves, the ntfy topic renders, etc. without waiting for a real event.
