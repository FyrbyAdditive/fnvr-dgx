#!/usr/bin/env bash
# Install the Hailo-8 PCIe driver + HailoRT userspace on the Jetson host —
# all from public GitHub sources, no developer-zone login required.
#
# We do NOT build the hailonet GStreamer plugin. The fnvr pipeline uses
# libhailort directly from a pad probe (apps/pipeline-supervisor/src/
# hailo_probe.cpp), so the gstreamer plugin isn't needed. Skipping it cuts
# build time and avoids the LGPL gstreamer-bindings code path.
#
# One-time operation. Run as root (or with sudo) on the Orin itself, not inside
# a container. Re-run safely — every step is idempotent.
#
# Pins both hailort-drivers and hailort to v4.23.0 (head of the hailo8 branch
# at time of writing). Host userspace version must match the version baked
# into the pipeline container image — if you bump HAILORT_VERSION here, bump
# the ARG in deploy/docker/Dockerfile.pipeline to match.
#
# What this script does:
#   1. Clones hailort-drivers @ v4.23.0, builds the kernel module via DKMS so
#      kernel upgrades auto-rebuild it.
#   2. modprobes hailo_pci, waits for /dev/hailo0.
#   3. Clones hailort @ v4.23.0, CMake-builds libhailort + hailortcli.
#   4. Installs to /usr/local (so apt's userspace stays untouched).
#   5. Stages the YOLOv11l HEF from Hailo's public Model Zoo S3 bucket into
#      the fnvr-data docker volume where the pipeline container expects it.
#
# First-time build is ~10-20 minutes on the Orin (CMake pulls in protobuf,
# spdlog, readerwriterqueue, etc. via FetchContent). Re-runs skip everything
# already present.
#
# Usage: sudo ./install-hailo-host.sh [--force-rebuild]

set -euo pipefail

FORCE_REBUILD="${1:-}"

HAILORT_VERSION="4.23.0"
HAILO_BRANCH="hailo8"
HAILO_TAG="v${HAILORT_VERSION}"

WORK_DIR="/opt/hailo-src"
DRIVERS_DIR="${WORK_DIR}/hailort-drivers"
HAILORT_DIR="${WORK_DIR}/hailort"
INSTALL_PREFIX="/usr/local"
HEF_NAME="yolov11l.hef"
# HEF is architecture-specific — hailo8 vs hailo8l (entry tier, half the
# compute). Detect at runtime using hailortcli to pick the matching HEF.
DEVICE_ARCH="$(/usr/local/bin/hailortcli fw-control identify 2>/dev/null \
    | awk -F': *' '/Device Architecture/ {print tolower($2); exit}')"
if [ -z "$DEVICE_ARCH" ]; then
    # Fallback: probe the module param / device fingerprint. Hailo-8L PCIe
    # device IDs are documented as 0x2864 just like Hailo-8 so we can't
    # discriminate there; default to hailo8l which is strictly smaller so
    # the 8l HEF also runs on an 8 (validated by hailort docs), whereas
    # the hailo8 HEF refuses to run on 8l.
    log "hailortcli didn't report arch — defaulting to hailo8l"
    DEVICE_ARCH="hailo8l"
fi
log "hailo device arch: $DEVICE_ARCH"
HEF_URL="https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/ModelZoo/Compiled/v2.18.0/${DEVICE_ARCH}/${HEF_NAME}"

if [ "$(id -u)" -ne 0 ]; then
    echo "hailo: must run as root (use sudo)." >&2
    exit 1
fi

log() { echo "hailo: $*"; }

log "build prerequisites"
apt-get update
# Core build chain — must succeed. DKMS is essential for the driver build.
apt-get install -y --no-install-recommends \
    git build-essential cmake pkg-config dkms \
    libglib2.0-dev
# Kernel headers on Jetson: prefer the JetPack package. Ignore "already
# installed" and missing-candidate failures — nvidia-l4t-kernel-headers
# puts sources under /usr/src/linux-headers-*-tegra and DKMS finds them
# via /lib/modules/$(uname -r)/build symlink.
apt-get install -y --no-install-recommends nvidia-l4t-kernel-headers || {
    log "nvidia-l4t-kernel-headers not found via apt — checking /lib/modules/$(uname -r)/build"
}
if [ ! -d "/lib/modules/$(uname -r)/build" ]; then
    log "FATAL: no kernel headers at /lib/modules/$(uname -r)/build"
    log "       install nvidia-l4t-kernel-headers or equivalent JetPack package"
    exit 1
fi

mkdir -p "$WORK_DIR"

###############################################################################
# 1. Kernel driver (DKMS)
###############################################################################
log "cloning hailort-drivers @ ${HAILO_TAG}"
if [ ! -d "$DRIVERS_DIR/.git" ]; then
    git clone --depth 1 --branch "$HAILO_TAG" \
        https://github.com/hailo-ai/hailort-drivers.git "$DRIVERS_DIR"
else
    (cd "$DRIVERS_DIR" && git fetch --depth 1 origin "refs/tags/${HAILO_TAG}:refs/tags/${HAILO_TAG}" \
        && git checkout -q "$HAILO_TAG")
fi

# Check dkms status for an existing install. If present and loaded, skip
# rebuild unless --force-rebuild.
DKMS_STATUS="$(dkms status hailo_pci 2>/dev/null || true)"
if [ -n "$DKMS_STATUS" ] && [ "$FORCE_REBUILD" != "--force-rebuild" ] && lsmod | grep -q '^hailo_pci'; then
    log "driver already installed via dkms and loaded — skipping rebuild"
    log "  (re-run with --force-rebuild to force)"
else
    log "building driver via DKMS"
    (cd "$DRIVERS_DIR/linux/pcie" && make install_dkms)

    log "loading kernel module"
    modprobe -r hailo_pci 2>/dev/null || true
    modprobe hailo_pci || {
        log "modprobe failed — check /var/lib/dkms/hailo_pci/*/build/make.log"
        exit 1
    }
fi

# Download + install the Hailo-8 firmware blob. The driver's probe path
# (not the userspace) issues a request_firmware("hailo/hailo8_fw.bin") during
# PCIe enumeration; without it the probe fails with err -2 and /dev/hailo0
# never appears. The firmware is a public S3 download.
FW_VERSION="${HAILORT_VERSION}"
FW_URL="https://hailo-hailort.s3.eu-west-2.amazonaws.com/Hailo8/${FW_VERSION}/FW/hailo8_fw.${FW_VERSION}.bin"
FW_DEST="/lib/firmware/hailo/hailo8_fw.bin"
if [ ! -s "$FW_DEST" ]; then
    log "downloading Hailo-8 firmware ${FW_VERSION}"
    mkdir -p "$(dirname "$FW_DEST")"
    curl -fsSL -o "${FW_DEST}.tmp" "$FW_URL"
    mv "${FW_DEST}.tmp" "$FW_DEST"
fi

log "reloading driver so firmware binds"
modprobe -r hailo_pci 2>/dev/null || true
modprobe hailo_pci || {
    log "modprobe failed after firmware install — check dmesg"
    exit 1
}

log "waiting for /dev/hailo0"
for i in $(seq 1 10); do
    if [ -c /dev/hailo0 ]; then break; fi
    sleep 1
done
if [ ! -c /dev/hailo0 ]; then
    log "/dev/hailo0 never appeared — check dmesg for PCIe errors"
    exit 1
fi

###############################################################################
# 2. HailoRT userspace + hailonet GStreamer plugin
###############################################################################
log "cloning hailort @ ${HAILO_TAG}"
if [ ! -d "$HAILORT_DIR/.git" ]; then
    git clone --depth 1 --branch "$HAILO_TAG" \
        https://github.com/hailo-ai/hailort.git "$HAILORT_DIR"
else
    (cd "$HAILORT_DIR" && git fetch --depth 1 origin "refs/tags/${HAILO_TAG}:refs/tags/${HAILO_TAG}" \
        && git checkout -q "$HAILO_TAG")
fi

# Skip rebuild if already installed at the expected version, unless forced.
INSTALLED_SO="${INSTALL_PREFIX}/lib/libhailort.so.${HAILORT_VERSION}"
if [ -e "$INSTALLED_SO" ] && [ "$FORCE_REBUILD" != "--force-rebuild" ]; then
    log "libhailort.so.${HAILORT_VERSION} already installed at ${INSTALL_PREFIX} — skipping rebuild"
else
    log "cmake-configuring hailort (this pulls ~200MB of deps on first run)"
    BUILD_DIR="${HAILORT_DIR}/build"
    rm -rf "$BUILD_DIR"
    cmake -S "$HAILORT_DIR" -B "$BUILD_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX" \
        -DHAILO_BUILD_GSTREAMER=OFF \
        -DHAILO_BUILD_EXAMPLES=OFF \
        -DHAILO_BUILD_UT=OFF

    log "building hailort (this is the slow part — ~15-25min on Orin)"
    cmake --build "$BUILD_DIR" --config Release -j"$(nproc)"

    log "installing hailort to ${INSTALL_PREFIX}"
    cmake --install "$BUILD_DIR" --config Release
    # The hailort install creates libhailort.so and libhailort.so.4.23.0 but
    # no libhailort.so.4 SONAME link — add it ourselves so ldd/dlopen resolves
    # the plain SONAME that consumers (including our compose overlay's
    # bind-mount) reference.
    if [ ! -L "${INSTALL_PREFIX}/lib/libhailort.so.4" ]; then
        ln -sf libhailort.so.${HAILORT_VERSION} "${INSTALL_PREFIX}/lib/libhailort.so.4"
    fi
    ldconfig
fi

###############################################################################
# 3. Sanity checks
###############################################################################
log "probing device with hailortcli"
"${INSTALL_PREFIX}/bin/hailortcli" scan || {
    log "hailortcli scan failed — device may not be properly enumerated"
    exit 1
}

###############################################################################
# 4. Stage HEF into the fnvr-data volume
###############################################################################
log "staging ${HEF_NAME} into fnvr-data volume"
docker run --rm -v fnvr_fnvr-data:/d alpine sh -c "
    set -e
    mkdir -p /d/models/hailo
    if [ ! -s /d/models/hailo/${HEF_NAME} ]; then
        apk add --no-cache curl >/dev/null 2>&1
        curl -fsSL -o /d/models/hailo/${HEF_NAME}.tmp '${HEF_URL}'
        mv /d/models/hailo/${HEF_NAME}.tmp /d/models/hailo/${HEF_NAME}
    fi
    ls -la /d/models/hailo/${HEF_NAME}
"

echo
log "install complete. Next steps:"
echo "  1. Recompose the pipeline with the Hailo overlay so the container"
echo "     picks up /dev/hailo0 and the new /usr/local bind-mounts:"
echo "       sudo docker compose -f deploy/docker/docker-compose.yml \\"
echo "                           -f deploy/docker/docker-compose.hailo.yml \\"
echo "                           up -d --force-recreate pipeline"
echo "  2. In the fnvr UI: Settings → Cameras → expand a camera → Backend: Hailo-8"
