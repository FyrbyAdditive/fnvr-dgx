# Install on Jetson

Target host: NVIDIA Jetson AGX Orin 64 GB dev kit with JetPack 6.2 and a dedicated NVMe for recordings.

Mac / x86 without a Jetson: skip to [developer/running-locally.md](../developer/running-locally.md).

## 1. Host prep (once per machine)

```bash
# Confirm the host is actually a Jetson running JetPack 6.x.
cat /etc/nv_tegra_release     # should show R36.x

# nvidia-container-toolkit installed, docker using the nvidia runtime.
docker info | grep -i runtime
# → Default Runtime: nvidia

# Peak performance power mode. Adjust to your thermal envelope.
sudo nvpmodel -m 0
sudo jetson_clocks

# NTP synced — segment filenames and event timestamps are evidence.
timedatectl status

# Recording disk. Recommend XFS + noatime on a dedicated NVMe.
sudo mkfs.xfs /dev/nvme1n1
sudo mkdir -p /var/lib/fnvr
sudo mount -o noatime /dev/nvme1n1 /var/lib/fnvr
# Persist via /etc/fstab.
sudo chown $USER /var/lib/fnvr        # dev only — tighten for prod.
```

UPS via `nut-client` is strongly recommended; a mid-write power cut can corrupt the last hour's `rec.mp4`.

## 2. First boot

```bash
git clone <repo> fnvr && cd fnvr
docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml logs -f api pipeline
```

On first boot:

- api-server runs goose migrations (22+ files) — this is fast.
- pipeline waits for at least one enabled camera before building a TRT engine. Without a camera it idles.
- nats + postgres + redis come up in seconds; everything else in under a minute if the images are local.

Point your browser at `http://<orin-ip>:8080`. Default login `admin / admin` — change it immediately via **Settings → Users**.

## 3. Add your first camera

- **Settings → Cameras → Add.** URL is an `rtsp://user:pass@host:port/path` string. Default protocol is TCP transport; the UI doesn't expose a UDP option yet.
- Optionally set `retention_days`, `quota_gb`, `location_kind` (indoor/outdoor) now. These are all editable later from the Storage page / Cameras page.

On save:
- The supervisor spawns a worker process for this camera.
- First inference run compiles the TRT engine (5–30 s on Orin for yolo26x FP16, up to 15 min for larger variants).
- Live view appears on the Live page with a "starting…" badge during compile, then flips to `running`.

If you don't have a camera yet, bring up the synthetic source: `docker compose --profile dev -f deploy/docker/docker-compose.yml up -d` publishes a testsrc stream at `rtsp://mediamtx:8554/test`.

## 4. First-run checklist

- **Live view** shows video within ~1 s.
- **Events** tab lists detections as they happen (SSE).
- **Timeline** plays recorded segments; event pins appear on the ruler.
- **Storage** page shows your camera's GB/day burn rate after ~1 hour of recording.
- `tegrastats` shows GPU / NVDEC / NVENC utilisation consistent with your camera count.

## 5. Optional

- **Per-camera retention.** Storage page → *edit* on a row. Ceiling 3650 days / 10 000 GB.
- **Face-ID.** Settings → Face-ID → Enable. See [face-id.md](face-id.md) before enrolling.
- **ANPR.** Settings → Detector → ANPR on. Camera-level toggle too.
- **MQTT / HA bridge.** Settings → Integrations. HA auto-discovers cameras + rules over MQTT.
- **Notifications.** Settings → Channels to create (webhook/ntfy/mqtt), then attach to rules inline on the Rules page.
- **Dual-NIC.** If you want to isolate the camera VLAN from the user LAN, see [dual-nic.md](dual-nic.md).

## Troubleshooting first boot

See [troubleshooting.md](troubleshooting.md). The two most common symptoms:

- **"streaming unsupported" / empty SSE.** Means some middleware isn't passing `http.Flusher` through. Fixed in recent builds; see the troubleshooting doc for details.
- **Pipeline "offline" banner but the video works.** Camera heartbeat drift. Confirm with [the troubleshooting doc's NATS heartbeat section](troubleshooting.md#pipeline-offline-but-the-video-is-fine).
