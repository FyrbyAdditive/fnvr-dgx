# Install on DGX Spark

Target host: NVIDIA DGX Spark (GB10 — 20-core Grace, Blackwell GPU,
128 GB coherent unified memory, 1× NVDEC / 1× NVENC) running DGX OS.
All GPU components run in containers — DeepStream has **no native
install** on this platform, and the pipeline image pins the one
supported base: `nvcr.io/nvidia/deepstream:9.1-triton-sbsa-dgx-spark`.

Mac / x86 without a Spark: skip to [developer/running-locally.md](../developer/running-locally.md).

## 1. Host prep (once per machine)

```bash
# Confirm platform + driver. DGX OS manages the NVIDIA driver — never
# install a driver from a CUDA runfile/repo; toolkit-only installs are
# fine and containers don't use them anyway.
nvidia-smi                     # driver 580.x+, GB10 listed
uname -r                       # -nvidia kernel flavour

# Docker with NVIDIA CDI (DGX OS default). There is NO `nvidia` docker
# runtime on DGX OS — compose uses device reservations instead, which
# ship in our compose file already.
docker info | grep -i cdi

# NTP synced — segment filenames and event timestamps are evidence.
timedatectl status

# Recording space. Recordings, models, engines and thumbnails all live
# in the fnvr-data docker volume; make sure the docker data-root disk
# has room (a 4K H.265 camera ≈ 30–60 GB/day before retention).
df -h /var/lib/docker
```

Networking note: if the Spark's uplink is WiFi, large host downloads
will starve the highest-bitrate camera streams (they self-heal, but
tiles blip). A wired NIC for camera traffic is strongly recommended —
see [dual-nic.md](dual-nic.md) and the WiFi entry in
[known-issues.md](known-issues.md).

UPS via `nut-client` is strongly recommended; a mid-write power cut
can corrupt the last recording segment.

## 2. First boot

```bash
git clone <repo> fnvr-dgx && cd fnvr-dgx/deploy/docker
cp .env .env.local 2>/dev/null || true
# REQUIRED: set FNVR_LAN_IP in .env to the host's LAN address(es),
# comma-separated. MediaMTX advertises these as WebRTC ICE hosts —
# wrong/missing values = black live tiles with "deadline exceeded".
# NEVER pass FNVR_LAN_IP as a shell variable; it must live in .env.
docker compose --profile gpu up -d
docker compose --profile gpu logs -f api pipeline
```

The pipeline image build (first time only) compiles OpenCV, the
DeepStream-Yolo and custom parser libraries, and exports the RF-DETR /
AdaFace / ANPR models — expect 30–60 minutes on first build, seconds
afterwards (layer cache).

On first boot:

- api-server runs goose migrations — fast.
- pipeline seeds models into the data volume and builds TRT engines on
  first use (RF-DETR base FP16 ≈ 1–3 min on GB10; cached afterwards).
- nats + postgres come up in seconds.

Point your browser at `http://<spark-ip>:8080`. Default login
`admin / admin` — change it immediately via **Settings → Users**.

## 3. Add your first camera

- **Settings → Cameras → Add.** URL is an
  `rtsp://user:pass@host:port/path` string (TCP transport).
- Editable later in place (name / URL / substream / rotation /
  detectors) — no re-create needed.
- **Substream (recommended at scale):** set the camera's low-res
  substream URL in the camera's Basics editor. Detection then decodes
  the substream while the full-res main stream is relayed to
  live/recordings with **zero decode cost** — the single NVDEC is the
  ~16-camera ceiling and this is how you stay under it. Keep the same
  aspect ratio as the main stream or overlay boxes will be offset.
- Camera-side encode settings that matter: plain H.264/H.265 only
  (smart/H.265+ modes emit B-frames, which WebRTC cannot carry), and
  an I-frame interval ≈ 1–4 s (live view joins wait for an IDR).

On save the supervisor plans the camera into a batched worker group
(cameras sharing a detector set share one process and one batched
engine pass). Note: config edits restart the group, briefly blipping
co-grouped cameras.

If you don't have a camera yet: `docker compose --profile dev up -d`
publishes a synthetic stream at `rtsp://mediamtx:8554/test`.

## 4. First-run checklist

- **Live view** shows video within a couple of seconds (up to one
  camera GOP on a fresh join).
- **Events** tab lists detections as they happen (SSE).
- **Timeline** plays recorded segments; event pins appear on the ruler.
- **Storage** page shows GB/day burn after ~1 hour.
- `nvidia-smi dmon -s um` — SM well under 50 % and `dec` consistent
  with camera count; `curl -s localhost:8081/metrics | grep
  fnvr_pipeline_member` shows per-camera input/push/infer rates in
  lockstep (~ camera fps each).

## 5. Optional

- **Per-camera retention.** Storage page → *edit* on a row.
- **Face-ID.** Settings → Face-ID → Enable (AdaFace IR-101 embedder).
  See [face-id.md](face-id.md) before enrolling.
- **ANPR.** Settings → Detector → ANPR on (global plate models).
  Camera-level detector toggles too.
- **Detector family.** RF-DETR (base) is the validated default;
  `yolo26` remains selectable in Settings → Detector.
- **MQTT / HA bridge.** Settings → Integrations.
- **Notifications.** Settings → Channels, then attach to rules.
- **Dual-NIC / camera VLAN.** See [dual-nic.md](dual-nic.md).

## Troubleshooting first boot

See [troubleshooting.md](troubleshooting.md) and
[known-issues.md](known-issues.md) (the GB10-specific traps live
there: container-only DeepStream, the Jetson-repo apt shadowing, the
unified-memory nvinfer pool guard, WebRTC B-frames).
