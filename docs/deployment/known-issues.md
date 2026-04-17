# Known issues

## DeepStream NVDEC/NVENC fails on this Orin host (JetPack 6.2)

**Symptoms.** When `FNVR_USE_DEEPSTREAM=1`, the pipeline logs:

```
Opening in BLOCKING MODE
Setting min object dimensions as 16x16 instead of 1x1 to support VIC compute mode.
...
Error while setting IOCTL
Invalid control
S_EXT_CTRLS for CUDA_GPU_ID failed
```

TensorRT engine builds successfully and the model loads, but `nvv4l2decoder` / `nvv4l2h265enc` cannot initialise. No segments are produced. Reproducible with a minimal GStreamer pipeline:

```
gst-launch-1.0 videotestsrc num-buffers=10 ! nvvidconv ! nvv4l2h264enc ! fakesink
```

**What we've ruled out.**
- Compose devices + `runtime: nvidia` + `NVIDIA_DRIVER_CAPABILITIES=all` all applied.
- `/dev/nvhost-ctrl-gpu`, `/dev/nvhost-gpu`, `/dev/nvmap`, `/dev/v4l2-nvdec`, `/dev/v4l2-nvenc` are all present inside the container and writable by root.
- The `nvidia-container-toolkit` CSV (`/etc/nvidia-container-runtime/host-files-for-container.d/devices.csv`) correctly lists the codec nodes.
- `libcuda.so.1` is byte-identical between `/usr/lib/aarch64-linux-gnu/tegra/` and `/usr/lib/aarch64-linux-gnu/nvidia/` (both are the host's Tegra libcuda, mounted in by nvidia-container-toolkit).
- Tegra v4l2 shim libraries (`libtegrav4l2.so`, `libnvcuvidv4l2.so`, `libnvmmlite_video.so`) all load successfully per `strace`.

**What's suspicious.** `/dev/v4l2-nvdec` and `/dev/v4l2-nvenc` on the host have `major,minor = 1,3` which is the major/minor of `/dev/null`. Compare with `/dev/video0` and `/dev/video1` which have `81,0` and `81,1` (the real V4L2 codec nodes). Possible that this Orin's udev rules or boot sequence has stale node creation.

**Workarounds.**
1. Run with `FNVR_USE_DEEPSTREAM=0` — gives you record-only (no detection). Currently the default on this host.
2. Re-flash / reset JetPack 6.2 and re-install nvidia-container-toolkit fresh, then re-check.
3. Use Triton Inference Server over gRPC from a sidecar container (bypasses local V4L2 codec path). Ambitious — lands with M3.

**Tracking.** Test on a second Orin to rule out host corruption; if it reproduces on a clean flash, file against NVIDIA.

## Update 2026-04-17 — progress since first write-up

Several contributing factors isolated and fixed; one remains. Detailed narrative:

1. **Wrong libcuda was a red herring.** `nvidia/libcuda.so.1` and `tegra/libcuda.so.1` are byte-identical on this host — the toolkit mounts the Tegra libcuda to both locations. The `LD_LIBRARY_PATH=tegra:tegra-egl` prefix in the entrypoint is kept for belt-and-braces but didn't change behaviour.

2. **`/dev/video0` and `/dev/video1` device bindings — not needed.** They are the `v4l2loopback`-ish generic nodes; the real codec access goes through `/dev/v4l2-nvenc` and `/dev/v4l2-nvdec` (already bound by nvidia-container-toolkit via devices.csv). Kept in compose for safety; harmless.

3. **Container had TWO `libv4l2_nvXXXvideocodec.so` plugins: the dGPU `libv4l2_nvcuvidvideocodec.so` and the Tegra `libv4l2_nvvideocodec.so`.** libv4l scans the plugin dir alphabetically and the "cuvid" variant sorts first. On Jetson the cuvid path fails (no dGPU NVENC). **Fix: entrypoint deletes the cuvid plugin symlink before starting the supervisor.** This got us past the `S_EXT_CTRLS for CUDA_GPU_ID failed` IOCTL error.

4. **New failure mode after fix 3:** `libv4l2: error getting capabilities: Invalid argument / It isn't a v4l2 driver`. The Tegra plugin now loads, opens `/dev/v4l2-nvenc`, and issues a generic `VIDIOC_QUERYCAP` IOCTL which the node rejects because its major/minor is `1,3` (a stub; the "real" codec access is arbitrated internally by NvMedia). On the host, the same libv4l2 plugin *doesn't* make that IOCTL — it fast-paths past it based on some runtime detection.

5. **Docker masks `/sys/firmware` by default.** Unmasked via `security_opt: ["systempaths=unconfined"]`. Devicetree now visible to the container — but did not change the error. So the detection branch in the plugin is not purely devicetree-based.

**Remaining blocker.** Something else distinguishes the host context from the container context that causes the Tegra `libv4l2_nvvideocodec.so` plugin to take different code paths. Candidates:
- `/proc/device-tree` (separate mount from `/sys/firmware/devicetree/base`).
- An `/etc/nv_tegra_release` style marker file the plugin reads.
- A specific environment variable the host's desktop session sets.
- An IPC socket (argus, nvhost control) the plugin handshakes with.

Next investigation: `strace -f -e trace=openat,read,ioctl` on the **host**'s working `gst-launch-1.0 ... ! nvv4l2h264enc ! fakesink` and diff against the container's trace filtered to `/sys`, `/proc`, `/dev`, `/tmp`, `/var` opens. The divergence point will be in the first few hundred syscalls.

**Pragmatic stance for now.** Stack runs in `FNVR_USE_DEEPSTREAM=0` (pure record) while this is unblocked. Rules engine, SSE live events, and the whole web UI work end-to-end already — they can consume detections from *any* source, including one produced off-Jetson (e.g. sidecar Triton or CPU-side inference), so shipping can progress without this resolved.
