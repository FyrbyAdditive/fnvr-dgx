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

exec /usr/local/bin/pipeline-supervisor "$@"
