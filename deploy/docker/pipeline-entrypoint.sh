#!/bin/sh
# Runs at container start, after nvidia-container-toolkit has bound the host
# Tegra libs into /usr/lib/aarch64-linux-gnu/tegra/.
#
# Two JetPack-6-on-DeepStream-L4T quirks we fix here:
#
# 1. Force ld.so to prefer tegra over nvidia/ so the Tegra libcuda wins.
#
# 2. The DeepStream-L4T image ships both Tegra AND dGPU variants of the
#    libv4l2 NVENC/NVDEC plugin. libv4l scans /usr/lib/.../libv4l/plugins/nv/
#    alphabetically and binds the first plugin that claims the device —
#    libv4l2_nvcuvidvideocodec.so (dGPU NVENC) sorts before
#    libv4l2_nvvideocodec.so (Tegra). The dGPU plugin fails with
#    "S_EXT_CTRLS for CUDA_GPU_ID failed" on Jetson because the dGPU NVENC
#    driver isn't there. Shadow the dGPU plugin so only the Tegra plugin
#    is visible.

set -e

if [ -d /usr/lib/aarch64-linux-gnu/tegra ]; then
    cat >/etc/ld.so.conf.d/000-fnvr-tegra-first.conf <<'EOF'
/usr/lib/aarch64-linux-gnu/tegra
/usr/lib/aarch64-linux-gnu/tegra-egl
EOF
    ldconfig
fi

# Only touch the plugin-dir symlink — the target file may be a bind-mount and
# unmovable. The symlink in /libv4l/plugins/nv/ is what libv4l actually scans.
# Ignore errors so a stricter mount layout doesn't kill the container.
rm -f /usr/lib/aarch64-linux-gnu/libv4l/plugins/nv/libv4l2_nvcuvidvideocodec.so 2>/dev/null || true

# Wipe GStreamer's cached plugin registry. The DeepStream-L4T image ships
# with a registry built against the image's initial lib layout; when we
# later installed libx264/libavcodec/libpq/etc., the registry still
# remembered those plugins as "failed to load".
rm -rf /root/.cache/gstreamer-1.0 /tmp/gst-* 2>/dev/null || true

# Seed the persistent model dir with the DeepStream samples on first boot.
# nvinfer auto-writes the serialised TRT engine next to onnx-file using a
# derived filename; if onnx-file lives in an ephemeral container dir the
# engine is wiped on every container recreate and we burn 60-90s rebuilding
# on every restart. Copying the assets onto the fnvr-data volume keeps the
# compiled engine persistent.
DS_SAMPLES=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector
DEST=/var/lib/fnvr/models/primary_detector
if [ -d "$DS_SAMPLES" ] && [ ! -f "$DEST/resnet18_trafficcamnet_pruned.onnx" ]; then
    mkdir -p "$DEST"
    cp "$DS_SAMPLES/resnet18_trafficcamnet_pruned.onnx" "$DEST/"
    cp "$DS_SAMPLES/cal_trt.bin" "$DEST/"
    cp "$DS_SAMPLES/labels.txt" "$DEST/"
    echo "entrypoint: seeded $DEST from $DS_SAMPLES"
fi

exec /usr/local/bin/pipeline-supervisor "$@"
