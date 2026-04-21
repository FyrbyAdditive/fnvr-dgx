# fnvr documentation

## Reading order

**If you're installing.** Start with [operations/install.md](operations/install.md), then skim [operations/settings.md](operations/settings.md) once you're logged in. If something doesn't work, go to [operations/troubleshooting.md](operations/troubleshooting.md).

**If you want to understand the system.** Read [architecture/README.md](architecture/README.md) top-to-bottom, then dive into the subsystem doc for whatever you're poking at.

**If you're developing.** [developer/repo-layout.md](developer/repo-layout.md) to get oriented, then [developer/running-locally.md](developer/running-locally.md).

## Contents

### Architecture

- [Overview](architecture/README.md) — services, data flow, who talks to whom.
- [Pipeline](architecture/pipeline.md) — DeepStream graph, WHEP live view, detection publish.
- [Rules engine](architecture/rules-engine.md) — zones, tripwires, schedules, cooldowns, cross-camera sequence rules, incident threading.
- [Storage](architecture/storage.md) — segment rotation, per-camera retention + quota, disk-pressure purge.
- [Face-ID](architecture/face-id.md) — detector + embedder models, matcher algorithm, drift detection.
- [Notifications](architecture/notifications.md) — channel types, subscription matching, Home Assistant bridge.
- [Data model + wire format](architecture/data-model.md) — key Postgres tables, NATS subjects, Prometheus metrics.

### Operations

- [Install on Jetson](operations/install.md) — host prep, compose up, adding the first camera.
- [Settings reference](operations/settings.md) — every `settings` row, what it does, safe ranges.
- [Storage management](operations/storage-management.md) — Storage page, retention, quota, disk-pressure floor.
- [Face-ID guide](operations/face-id.md) — enrol people, tune the matcher, read the drift pill, clean up an enrolment pool.
- [Upgrades](operations/upgrade.md) — `docker compose pull`, what migrations do.
- [Troubleshooting](operations/troubleshooting.md) — symptoms we've hit, with the actual fixes.
- [Known issues](operations/known-issues.md) — upstream bugs we cannot fix; their workarounds.
- [Dual-NIC deployment](operations/dual-nic.md) — isolating cameras from the user LAN.

### Developer

- [Repo layout](developer/repo-layout.md) — where each service lives.
- [Running locally](developer/running-locally.md) — Mac / x86 path, lite + dev profiles.
- [Migrations](developer/migrations.md) — goose, how to add one.
- [NATS subjects](developer/nats-subjects.md) — the full bus taxonomy.
- [Prometheus metrics](developer/metrics.md) — what api-server and event-processor expose.
- [Building the pipeline](developer/building-pipeline.md) — C++ / DeepStream notes.

### Compliance

- [Compliance overview](compliance/README.md) — DPIA, model cards, BIPA/UK Biometrics disclosures.
