# proto

Shared protocol buffers for:
- `pipeline.proto` — gRPC control surface between `api-server` and `pipeline-supervisor`.
- `events.proto` — detection / incident payloads on NATS (`fnvr.events.*`).

## Building

Install `buf`:
```
brew install bufbuild/buf/buf
# or download from https://github.com/bufbuild/buf/releases
```

Regenerate after proto edits:
```
cd libs/proto
buf generate
```

Outputs:
- Go: `libs/go-common/gen/fnvr/…/*.pb.go` (api-server imports this)
- C++: `apps/pipeline-supervisor/src/gen/` (linked into the pipeline supervisor)

## Wire transport

- Control (api-server → pipeline-supervisor): gRPC over TCP, unencrypted on the
  internal docker network. Add mTLS in M5 when federation lands.
- Events (pipeline-supervisor → api-server + event-processor): NATS JetStream,
  JSON-encoded proto3 for M2 (easier debugging), binary proto in M3.

## Subjects

- `fnvr.events.detection.<camera_id>` — per-frame inference hits.
- `fnvr.events.incident.<camera_id>` — rule-matched, correlated events.
- `fnvr.events.system.<kind>` — camera state changes, health, etc.
- `fnvr.jobs.ml.<kind>` — training / evaluation job requests.
