# Hailo-8 PCIe accelerator

Optional per-camera inference backend. When a camera's `detector_backend`
is set to `hailo`, the pipeline-supervisor installs an in-process
libhailort pad probe in place of the nvinfer PGIE for that worker's
graph, moving primary object detection off the Orin GPU onto the
Hailo-8's NN core. The DeepStream tracker, ANPR SGIEs, face-ID SGIEs,
NVENC recording path, and NVDEC decode all stay on the Orin — only the
primary detector moves. Expect:

- **GPU load drop** proportional to how much of the GR3D budget that
  camera's PGIE was eating. On a busy 6-camera deployment running
  yolo26l, 30-50% of GR3D comes from PGIE. Moving one heavy camera
  onto Hailo returns 5-10 pp of GR3D to the pool.
- **~1.5-2 mAP accuracy loss** vs yolo26l: the shipped Hailo model is
  `yolov11l.hef` (53.4 mAP on COCO vs yolo26l's 55.0). Usually
  imperceptible for typical NVR use cases (people + vehicles in frame).
- **~15 ms per-frame latency** on Hailo-8 at 640×640 batch-1. Our
  ingest runs 10-30 FPS per camera; Hailo keeps up with headroom.
- **Tracking + SGIEs unchanged.** The pad probe injects `NvDsObjectMeta`
  into the DeepStream batch exactly as nvinfer would, so nvtracker gets
  the same bbox list, track_ids stay stable, and LPDNet/LPRNet/SCRFD/
  ArcFace all run on Hailo-backed cameras with no feature loss.

## Architecture (why no hailonet / TAPPAS)

The obvious integration — `rtspsrc ! ... ! hailonet ! hailofilter ! nvtracker`
— doesn't work cleanly on DeepStream: `hailonet` re-emits a fresh
GstBuffer on its src pad rather than forwarding the input, which drops
`NvDsBatchMeta` and breaks DeepStream's metadata flow. Rather than
splitting pipelines or forking hailonet, we skip the GStreamer plugin
entirely and call `libhailort`'s C++ API (`VDevice` + `InferModel` +
sync `run()`) from a pad probe. See
[apps/pipeline-supervisor/src/hailo_inference.cpp](../../apps/pipeline-supervisor/src/hailo_inference.cpp)
and [hailo_probe.cpp](../../apps/pipeline-supervisor/src/hailo_probe.cpp).

No dependency on TAPPAS (LGPL) or the hailonet/hailofilter plugins.
Only `libhailort.so` (MIT) + the kernel driver (GPL-2) are required.

## Install on the host

One-time setup, rerun after a kernel upgrade (DKMS handles the rebuild
automatically; rerun only if `modprobe hailo_pci` fails afterwards):

```sh
cd ~/fnvr
sudo ./deploy/hailo/install-hailo-host.sh
```

The script, all from public GitHub sources — no Hailo developer-zone
login required:
1. Clones `hailo-ai/hailort-drivers` @ v4.23.0 (hailo8 branch), builds
   `hailo_pci.ko` via DKMS so kernel upgrades auto-rebuild it.
2. `modprobe hailo_pci`, waits for `/dev/hailo0`.
3. Clones `hailo-ai/hailort` @ v4.23.0, CMake-builds libhailort +
   hailortcli with `HAILO_BUILD_GSTREAMER=OFF` (we don't need it —
   see architecture note above).
4. Installs userspace to `/usr/local` (apt's filesystem untouched).
5. `hailortcli scan` to confirm the chip is reachable.
6. Stages `yolov11l.hef` (Hailo Model Zoo v2.13.0) into the `fnvr-data`
   docker volume where the pipeline container expects it.

First-time build is ~10-20 min on Orin (CMake fetches protobuf, spdlog,
readerwriterqueue, etc.). Subsequent runs skip every already-installed
step unless you pass `--force-rebuild`.

If the modprobe step fails, check `/var/lib/dkms/hailo_pci/*/build/make.log`
for kernel-header / gcc issues — JetPack 6.2 ships the needed headers so
this is rare.

After install, restart the pipeline container with the Hailo compose
overlay so it binds `/dev/hailo0` and the host's libhailort:

```sh
sudo docker compose \
  -f deploy/docker/docker-compose.yml \
  -f deploy/docker/docker-compose.hailo.yml \
  up -d --force-recreate pipeline
```

The pipeline image itself also contains a compiled libhailort (baked at
image build — see [deploy/docker/Dockerfile.pipeline](../../deploy/docker/Dockerfile.pipeline)),
but the overlay bind-mounts the host copy on top. This guarantees host
driver ABI and container userspace stay in lockstep: a driver-userspace
version mismatch surfaces as silent `VDevice::create()` failures in the
500-range status codes.

## Flip a camera to Hailo

Settings → Cameras → expand a camera row → "Backend" dropdown → select
**Hailo-8 (PCIe)** and save. The supervisor respawns just that camera's
worker (other cameras unaffected). Within ~5 s `docker logs fnvr-pipeline-1`
shows the new graph with a no-op `queue name=pgie` in place of `nvinfer`,
and a line:

```
pipeline[<cam_id>]: hailo-8 inference probe attached on pgie.src
hailo: configured yolov11l — 80 classes, up to 100 bboxes/class, input=1228800B, output=...B
```

To roll back: same dropdown, pick **TensorRT (GPU)**.

## Troubleshooting

- **Hailo option greyed out in the UI.** api-server can't stat
  `/dev/hailo0` from inside its container. Either the host install
  didn't run, the module isn't loaded, or the pipeline container was
  started before the install. `ls -l /dev/hailo0` on the host, then
  restart with the compose overlay.
- **`hailortcli scan` hangs or prints no device.** The PCIe link is up
  (lspci shows the device) but the driver isn't binding. Try
  `sudo rmmod hailo_pci && sudo modprobe hailo_pci` — clears a stuck
  state. If still broken, check `dmesg | grep -i hailo` for PCIe AER
  errors.
- **Worker on a Hailo camera starts but emits zero detections.** Most
  likely cause: the shipped HEF wasn't staged into the `fnvr-data`
  volume. `docker run --rm -v fnvr_fnvr-data:/d alpine ls -la /d/models/hailo/`
  should show `yolov11l.hef`. If missing, rerun the install script (the
  HEF staging step is idempotent).
- **`VDevice::create` returns status 500+.** Driver/userspace version
  mismatch. The script pins both to v4.23.0; if you bumped one without
  the other, rerun with `--force-rebuild`.
- **Detections but bboxes look wrong / off-frame.** Letterboxing issue
  between source aspect and the 640×640 network input. Check the worker
  log for the source width/height — if those differ from the actual
  camera dims, the supervisor has stale probed dimensions; restart the
  worker via the UI backend dropdown (flip off, flip back).
