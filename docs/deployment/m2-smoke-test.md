# M2 smoke test — end-to-end on the Orin

Assumes the Jetson AGX Orin host is set up per [jetson-host-setup.md](jetson-host-setup.md) and `nvidia-container-toolkit` is installed.

## Prepare the host

```bash
# on the Orin
sudo mkdir -p /var/lib/fnvr
sudo chown $USER /var/lib/fnvr     # dev only — tighten for prod

# pick the MAXN power mode for peak perf; throttle later if thermals complain
sudo nvpmodel -m 0 && sudo jetson_clocks
```

## Start the stack

```bash
git clone <this repo> fnvr && cd fnvr
cp deploy/config/fnvr.sample.yaml deploy/config/fnvr.yaml

# Point the pipeline at one camera via env for M2. In M3 the gRPC control
# plane takes over and you add cameras via the web UI instead.
export FNVR_CAMERA_ID=front
export FNVR_CAMERA_URL="rtsp://user:pass@10.0.0.42:554/Streaming/Channels/101"

docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml logs -f pipeline api
```

UI: http://<orin-ip>:8080 — default login `admin / admin` (change immediately).

## Without real cameras

Enable the `dev` profile to spin up a synthetic RTSP source at `rtsp://mediamtx:8554/test`:

```bash
docker compose --profile dev -f deploy/docker/docker-compose.yml up -d
FNVR_CAMERA_URL="rtsp://mediamtx:8554/test"
```

## Verifying the pipeline

```bash
# 1. container is healthy
docker compose ps

# 2. segments are hitting disk
ls -lR /var/lib/fnvr/recordings | tail

# 3. play a segment back (pick any)
ffplay /var/lib/fnvr/recordings/$(date -u +%Y/%m/%d/%H)/front/seg-00000.mp4

# 4. detection events on NATS
docker run --rm --network fnvr_default natsio/nats-box \
  nats --server=nats://nats:4222 sub 'fnvr.events.>'

# 5. UI event feed
# Open http://<orin>:8080/events — detections appear live via SSE

# 6. Jetson health
tegrastats      # GPU / NVDEC / NVENC / RAM / temps
```

## Common gotchas

- **"failed to set PLAYING"** in `pipeline` logs, no segments → verify the RTSP URL with `ffprobe rtsp://…` on the host first. Firewall the camera's subnet? Wrong credentials? Wrong transport (TCP vs UDP)?
- **Engine build takes minutes on first run** — TensorRT compiles the `.engine` from the ETLT/ONNX. Subsequent restarts are instant. Progress is in `pipeline` logs.
- **`sudo nvpmodel -m 0` not available** → you're not on a Jetson host. Use the `lite` profile (no pipeline container); the rest of the stack still exercises.
- **Permission on `/var/lib/fnvr`** → the pipeline container runs as root inside; make sure the host mount is writable.

## What "M2 done" looks like

1. At least one RTSP camera reaches `running` state and stays there for 10 minutes.
2. `/var/lib/fnvr/recordings/…/seg-*.mp4` grows continuously; each segment plays cleanly in `ffplay`.
3. Pulling the camera's network cable: within 30 s the supervisor backs off and reconnects without the container exiting.
4. Detections land on NATS and in the Events tab at > 1/s when people/vehicles are in frame.
5. Reloading the UI after login doesn't bounce you back to `/login`.
