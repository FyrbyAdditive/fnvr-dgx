# notification-dispatcher

Go service that consumes incidents from NATS and fans out via: webhook, MQTT, Home Assistant, email, ntfy, Telegram, Signal, push (FCM/APNs/Web Push), SIP, GPIO relay, SNMP. Per-user subscriptions, rate-limiting, snooze, escalation.

Lands in M3. M1 stub only.
