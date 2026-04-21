# proto

Shared protocol buffers for:

- `pipeline.proto` — gRPC control surface between `api-server` and `pipeline-supervisor`.
- `events.proto` — detection / incident payloads on NATS.

## Building

```sh
brew install bufbuild/buf/buf            # or via apt / the github release
cd libs/proto
buf generate
```

Outputs:
- Go: `libs/go-common/gen/fnvr/…/*.pb.go`.
- C++: `apps/pipeline-supervisor/src/gen/`.

## Wire format

- **NATS payloads are JSON**, not binary proto. The proto definitions are the source of truth for field names + shapes but the on-wire format is JSON-encoded for debuggability. Keep it that way until a measurable payload-size problem appears.
- **Control RPCs are gRPC over TCP** on the internal docker bridge, unencrypted. mTLS would land with federation (PLAN.md §7).

## Subjects

Full taxonomy in [docs/developer/nats-subjects.md](../../docs/developer/nats-subjects.md). Summary:

- `fnvr.events.detection.<camera_id>` — per-frame inference hits.
- `fnvr.events.incident.<camera_id>` — rule / hotlist / face / drift incidents. `__system` for system-scope.
- `fnvr.state.camera.<camera_id>` — JetStream last-value per-camera heartbeat.
- `fnvr.state.pipeline` — parent supervisor state.
- `fnvr.alerts.drift` — ml-worker drift alert.
- `fnvr.models.faceid.reload` — ask pipeline to reload `arcface.onnx`.
- `fnvr.whep.registry` — pipeline publishes `{camera_id, port}` when a WHEP listener binds.
