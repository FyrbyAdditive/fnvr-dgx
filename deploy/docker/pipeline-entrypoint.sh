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

# ---- YOLO26 model bootstrap ----
#
# Seed /var/lib/fnvr/models/yolo26/ with the ONNX weights baked into the
# image. This is idempotent — cp -n only writes files that don't already
# exist, so a newer image with a re-exported ONNX only lands after the
# user manually removes the old file (avoids invalidating cached TRT
# engines mid-upgrade, which would force a ~10-minute rebuild).
YOLO_SRC=/opt/fnvr/yolo26
YOLO_DEST=/var/lib/fnvr/models/yolo26
if [ -d "$YOLO_SRC" ]; then
    mkdir -p "$YOLO_DEST"
    for f in "$YOLO_SRC"/*.onnx; do
        [ -f "$f" ] || continue
        cp -n "$f" "$YOLO_DEST/"
    done
    # Labels — copied from the repo's coco.labels via the COPY into
    # /etc/fnvr/nvinfer; always refresh since it's tiny and text.
    if [ -f /etc/fnvr/nvinfer/coco.labels ]; then
        cp /etc/fnvr/nvinfer/coco.labels "$YOLO_DEST/labels.txt"
    fi
    echo "entrypoint: yolo26 weights ready under $YOLO_DEST"
fi

# ANPR: seed the ONNX weights from /opt/fnvr/anpr/ (baked into the
# image) onto the fnvr-data volume. nvinfer writes the derived TRT
# engine next to the ONNX file — with the ONNX on a persistent volume,
# the engine ends up on disk too, and subsequent container recreates
# skip the ~2 min per-engine build. Without this, /opt is ephemeral,
# so every recreate forces a rebuild.
ANPR_SRC=/opt/fnvr/anpr
ANPR_DEST=/var/lib/fnvr/models/anpr
mkdir -p "$ANPR_DEST"
if [ -d "$ANPR_SRC" ]; then
    for f in "$ANPR_SRC"/*.onnx; do
        [ -f "$f" ] || continue
        cp -n "$f" "$ANPR_DEST/"
    done
    echo "entrypoint: anpr weights ready under $ANPR_DEST"
fi

# ---- Resolve detector settings & render nvinfer config ----
#
# Reads settings from the api via FNVR_SETTINGS_URL. If unreachable (api
# still starting, or single-service test), fall back to env defaults.
# Announces calibrating / compiling_engine states on NATS so the UI
# banner can explain the delay.

VARIANT="${FNVR_YOLO_VARIANT:-yolo26x}"
PRECISION="${FNVR_YOLO_PRECISION:-fp16}"

SETTINGS_URL="${FNVR_SETTINGS_URL:-http://api:8081/api/v1/internal/detector}"
if command -v curl >/dev/null 2>&1; then
    # Best-effort fetch; ignore failure. 5s timeout because the api may be
    # starting in parallel. Retry a couple of times since the api may still
    # be running its DB migration on first-ever boot.
    SETTINGS_JSON=""
    for _ in 1 2 3; do
        SETTINGS_JSON=$(curl -s --max-time 5 "$SETTINGS_URL" 2>/dev/null || true)
        [ -n "$SETTINGS_JSON" ] && break
        sleep 2
    done
    if [ -n "$SETTINGS_JSON" ]; then
        V=$(echo "$SETTINGS_JSON" | sed -n 's/.*"yolo26_variant":"\([^"]*\)".*/\1/p')
        P=$(echo "$SETTINGS_JSON" | sed -n 's/.*"yolo26_precision":"\([^"]*\)".*/\1/p')
        A=$(echo "$SETTINGS_JSON" | sed -n 's/.*"anpr_enabled":\(true\|false\).*/\1/p')
        F=$(echo "$SETTINGS_JSON" | sed -n 's/.*"face_id_enabled":\(true\|false\).*/\1/p')
        [ -n "$V" ] && VARIANT="$V"
        [ -n "$P" ] && PRECISION="$P"
        if [ "$A" = "true" ]; then
            export FNVR_USE_ANPR=1
        else
            export FNVR_USE_ANPR=0
        fi
        if [ "$F" = "true" ]; then
            export FNVR_USE_FACEID=1
        else
            export FNVR_USE_FACEID=0
        fi
    fi
fi

# Persistent model + engine dir for face-id. We copy the ONNX weights
# out of the image onto the fnvr-data volume (same pattern as yolo26)
# so the derived TRT engine file nvinfer auto-writes lives next to the
# ONNX on a persistent volume. If the ONNX lives at the read-only
# /opt path, nvinfer still builds an engine but it's ephemeral — each
# container recreate triggers a multi-minute rebuild on *every* worker
# in parallel, which OOM-kills them on devices with tight GPU memory.
FACEID_SRC=/opt/fnvr/faceid
FACEID_DEST=/var/lib/fnvr/models/faceid
mkdir -p "$FACEID_DEST"
if [ -d "$FACEID_SRC" ]; then
    for f in "$FACEID_SRC"/*.onnx; do
        [ -f "$f" ] || continue
        cp -n "$f" "$FACEID_DEST/"
    done
    echo "entrypoint: faceid weights ready under $FACEID_DEST"
fi

echo "entrypoint: detector variant=$VARIANT precision=$PRECISION anpr=${FNVR_USE_ANPR:-0} face=${FNVR_USE_FACEID:-0}"

# Fetch the current camera list and publish a "starting" state for each
# one so the Live tiles don't show "pipeline offline" during the long
# calibrate/compile phases. Keeps the per-camera state in sync with the
# global pipeline-state banner.
CAMERAS_JSON=$(curl -s --max-time 5 "http://api:8081/api/v1/internal/cameras" 2>/dev/null || true)
# Parser: the payload is a single JSON array on one line. Use grep -o to
# extract all "id":"..." occurrences, then cut to the id value.
printf '%s' "$CAMERAS_JSON" \
    | grep -oE '"id":"[^"]*"' \
    | sed 's/"id":"\([^"]*\)"/\1/' \
    | while read -r CID; do
        [ -z "$CID" ] && continue
        PAYLOAD=$(printf '{"camera_id":"%s","state":"starting"}' "$CID")
        /usr/local/bin/pipeline-supervisor --publish "fnvr.state.camera.$CID" "$PAYLOAD" || true
        echo "entrypoint: published starting for $CID"
    done

# publish_state uses the pipeline-supervisor binary's --publish subcommand.
# Same nats.c connection code the supervisor itself uses for detections —
# so no parallel NATS client to maintain. Payloads stay valid JSON and
# JetStream correctly captures them via the MaxMsgsPerSubject=1 stream
# api-server declares.
publish_state() {
    state_name="$1"; message="$2"
    # Escape " in message — the message is usually static so keep it simple.
    safe_msg=$(printf '%s' "$message" | sed 's/"/\\"/g')
    payload=$(printf '{"state":"%s","variant":"%s","precision":"%s","message":"%s"}' \
        "$state_name" "$VARIANT" "$PRECISION" "$safe_msg")
    /usr/local/bin/pipeline-supervisor --publish fnvr.state.pipeline "$payload" || true
}

# report_calibration posts the outcome of a trtexec run to the api
# so the Settings page can surface success / failure without
# scraping container logs. Best-effort — never fail the startup on
# a POST error.
report_calibration() {
    local payload="$1"
    curl -fsS --max-time 5 -X POST \
        -H 'Content-Type: application/json' -d "$payload" \
        http://api:8081/api/v1/internal/detector/calibration_report \
        >/dev/null 2>&1 || true
}

# INT8 path: produce the calibration table + engine offline with
# trtexec (see calibrate-yolo26.sh). The in-process TRT calibrator
# crashes on this ONNX with TRT 10.3 ("Assertion item.second != nullptr")
# so we bypass it entirely. On success, nvinfer on first worker start
# just deserialises the pre-built engine. On any failure we fall
# back to FP16 so the container never crash-loops.
if [ "$PRECISION" = "int8" ]; then
    CALIB_TABLE="$YOLO_DEST/${VARIANT}.calib.table"
    ENGINE_INT8="$YOLO_DEST/${VARIANT}.onnx_b1_gpu0_int8.engine"

    if [ ! -f "$CALIB_TABLE" ] || [ ! -f "$ENGINE_INT8" ]; then
        CALIB_DIR="$YOLO_DEST/calib_images"
        N_IMAGES=0
        if [ -d "$CALIB_DIR" ]; then
            N_IMAGES=$(find "$CALIB_DIR" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l)
        fi
        if [ "$N_IMAGES" -lt 100 ]; then
            msg="INT8 calibration needs ≥100 frames in $CALIB_DIR (have $N_IMAGES). Click Prepare calibration images in Settings. Falling back to FP16."
            publish_state "failed" "$msg"
            report_calibration "{\"ok\":false,\"err\":\"$(printf '%s' "$msg" | sed 's/"/\\"/g')\"}"
            echo "entrypoint: $msg"
            PRECISION="fp16"
        else
            publish_state "calibrating" "Calibrating INT8 for $VARIANT using $N_IMAGES images via trtexec. Takes ~3-5 minutes; cached on disk."
            echo "entrypoint: running offline calibration ($N_IMAGES images)"
            CALIB_LOG="$YOLO_DEST/calibrate.log"
            if /usr/local/bin/calibrate-yolo26.sh "$VARIANT" "$CALIB_TABLE" >"$CALIB_LOG" 2>&1; then
                # Verify outputs: table non-empty, engine > 100MB
                # (yolo26x INT8 engine is ~150-200MB; anything much
                # smaller means the build was truncated).
                ENGINE_BYTES=0
                if [ -f "$ENGINE_INT8" ]; then
                    ENGINE_BYTES=$(stat -c %s "$ENGINE_INT8" 2>/dev/null || echo 0)
                fi
                TABLE_BYTES=0
                if [ -f "$CALIB_TABLE" ]; then
                    TABLE_BYTES=$(stat -c %s "$CALIB_TABLE" 2>/dev/null || echo 0)
                fi
                if [ "$TABLE_BYTES" -gt 0 ] && [ "$ENGINE_BYTES" -gt 104857600 ]; then
                    TABLE_SHA=$(sha256sum "$CALIB_TABLE" | cut -d' ' -f1)
                    echo "$TABLE_SHA" > "$YOLO_DEST/${VARIANT}.calib.sha256"
                    echo "entrypoint: calibration OK (engine=${ENGINE_BYTES}B, table=${TABLE_BYTES}B, sha=${TABLE_SHA:0:16}…)"
                    report_calibration "{\"ok\":true,\"engine_size\":$ENGINE_BYTES,\"table_sha256\":\"$TABLE_SHA\"}"
                else
                    ERR=$(tail -n 20 "$CALIB_LOG" | sed 's/"/\\"/g' | tr '\n' ' ' | cut -c1-1500)
                    msg="Calibration artefacts too small (engine=${ENGINE_BYTES}B, table=${TABLE_BYTES}B). Falling back to FP16."
                    publish_state "failed" "$msg"
                    report_calibration "{\"ok\":false,\"err\":\"$msg | log tail: $ERR\"}"
                    echo "entrypoint: $msg"
                    rm -f "$ENGINE_INT8" "$CALIB_TABLE"
                    PRECISION="fp16"
                fi
            else
                ERR=$(tail -n 20 "$CALIB_LOG" 2>/dev/null | sed 's/"/\\"/g' | tr '\n' ' ' | cut -c1-1500)
                msg="Calibration failed (trtexec exit non-zero). Falling back to FP16."
                publish_state "failed" "$msg"
                report_calibration "{\"ok\":false,\"err\":\"$msg | log tail: $ERR\"}"
                echo "entrypoint: $msg"
                echo "entrypoint: calibrate.log tail:" >&2
                tail -n 40 "$CALIB_LOG" >&2 || true
                rm -f "$ENGINE_INT8" "$CALIB_TABLE"
                PRECISION="fp16"
            fi
        fi
    fi
fi

# TRT engine cache check. If missing, we're about to trigger a multi-
# minute compile — announce it for the UI banner.
ENGINE_SUFFIX="fp16"
NETWORK_MODE="2"
INT8_LINE="#"
if [ "$PRECISION" = "int8" ]; then
    ENGINE_SUFFIX="int8"
    NETWORK_MODE="1"
    INT8_LINE="int8-calib-file=$YOLO_DEST/${VARIANT}.calib.table"
fi

ENGINE_FILE="$YOLO_DEST/${VARIANT}.onnx_b1_gpu0_${ENGINE_SUFFIX}.engine"
ONNX_FILE="$YOLO_DEST/${VARIANT}.onnx"

# Detect stale / corrupt engines so they get rebuilt on next startup:
#   - zero-byte: killed mid-build
#   - smaller than 1 MB: almost certainly truncated or wrong layout
#   - older than its ONNX: ONNX re-exported since last build
# Anything matching → remove, so the block below treats it as missing.
if [ -f "$ENGINE_FILE" ]; then
    ENGINE_SIZE=$(stat -c %s "$ENGINE_FILE" 2>/dev/null || echo 0)
    if [ "$ENGINE_SIZE" -lt 1048576 ]; then
        echo "entrypoint: engine $ENGINE_FILE is ${ENGINE_SIZE} bytes (suspiciously small) — removing for rebuild"
        rm -f "$ENGINE_FILE"
    elif [ -f "$ONNX_FILE" ] && [ "$ONNX_FILE" -nt "$ENGINE_FILE" ]; then
        echo "entrypoint: engine older than its ONNX ($ONNX_FILE newer than $ENGINE_FILE) — removing for rebuild"
        rm -f "$ENGINE_FILE"
    fi
fi

if [ ! -f "$ENGINE_FILE" ]; then
    publish_state "compiling_engine" "Building TensorRT engine for $VARIANT ($PRECISION). This variant + precision combo hasn't been built before on this device; can take a few minutes."
    echo "entrypoint: engine $ENGINE_FILE missing — nvinfer will build it on first worker start"
    # nvinfer does the build correctly; trtexec requires fiddly dynamic-
    # shape flags matching the ONNX's export profile and still produced
    # engines with 0 visible output layers. Accept the slower per-worker
    # compile path; the supervisor staggers workers so only the first
    # does the heavy lifting, the rest deserialize from cache in ~2s.
fi

# Render effective config into a writable location. /etc/fnvr is bind-
# mounted read-only from the host's deploy/config, so put the rendered
# file on the fnvr-data volume next to the models.
export MODEL="$VARIANT"
export NETWORK_MODE ENGINE_SUFFIX INT8_LINE
EFFECTIVE_CFG="$YOLO_DEST/yolo26.effective.txt"
if command -v envsubst >/dev/null 2>&1; then
    envsubst '$MODEL $NETWORK_MODE $ENGINE_SUFFIX $INT8_LINE' \
        < /etc/fnvr/nvinfer/yolo26.txt.template \
        > "$EFFECTIVE_CFG"
else
    sed \
        -e "s|\$MODEL|$MODEL|g" \
        -e "s|\$NETWORK_MODE|$NETWORK_MODE|g" \
        -e "s|\$ENGINE_SUFFIX|$ENGINE_SUFFIX|g" \
        -e "s|\$INT8_LINE|$INT8_LINE|g" \
        /etc/fnvr/nvinfer/yolo26.txt.template \
        > "$EFFECTIVE_CFG"
fi

# Default to YOLO26 unless the operator has pinned a specific config via
# the env (e.g. the old trafficcamnet for rollback).
if [ -z "$FNVR_INFER_CONFIG" ] || [ "$FNVR_INFER_CONFIG" = "/etc/fnvr/nvinfer/trafficcamnet.txt" ]; then
    if [ -f /var/lib/fnvr/models/yolo26/"$VARIANT".onnx ]; then
        export FNVR_INFER_CONFIG="$EFFECTIVE_CFG"
    fi
fi

echo "entrypoint: FNVR_INFER_CONFIG=$FNVR_INFER_CONFIG"

exec /usr/local/bin/pipeline-supervisor "$@"
