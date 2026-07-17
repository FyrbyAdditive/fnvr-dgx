#!/bin/sh
# Runs at container start on DGX Spark (DS 9.1 SBSA container).
#
# The Orin-era Tegra quirk-fixes (tegra ld.so priority, libv4l dGPU
# plugin shadowing) are gone — SBSA is a straight dGPU-style platform.

set -e

# Pin the LEGACY nvstreammux. Our pipeline graph uses legacy-only
# properties (width/height/enable-padding/live-source/
# batched-push-timeout) and the probes' bbox normalisation assumes the
# legacy mux's scaling+letterbox behaviour. DS 9.x nudges toward the
# new mux on some platforms; migrating is a deliberate future change,
# not something to discover mid-incident.
export USE_NEW_NVSTREAMMUX=no

# Wipe GStreamer's cached plugin registry. The base image ships with a
# registry built against the image's initial lib layout; our apt
# installs (libpq, gst plugin sets, ...) can leave stale "failed to
# load" entries behind otherwise.
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

# ANPR: seed the plate detector/OCR ONNX + charset labels + meta from
# /opt/fnvr/anpr/ (baked into the image) onto the fnvr-data volume.
# nvinfer writes the derived TRT engine next to the ONNX file — with
# the ONNX on a persistent volume the engine survives recreates.
ANPR_SRC=/opt/fnvr/anpr
ANPR_DEST=/var/lib/fnvr/models/anpr
mkdir -p "$ANPR_DEST"
if [ -d "$ANPR_SRC" ]; then
    # Content-compare instead of cp -n: when an image upgrade changes
    # an ONNX (e.g. the NCHW-wrapper rework), the stale volume copy AND
    # its cached engines must be replaced, or nvinfer deserialises an
    # engine that no longer matches the config.
    for f in "$ANPR_SRC"/*.onnx; do
        [ -f "$f" ] || continue
        dst="$ANPR_DEST/$(basename "$f")"
        if ! cmp -s "$f" "$dst"; then
            cp -f "$f" "$dst"
            rm -f "${dst%.onnx}".onnx_b*_gpu0_*.engine
            echo "entrypoint: refreshed $(basename "$f") (+ dropped stale engines)"
        fi
    done
    # Charset + meta are tiny and derived from the model config —
    # always refresh so an image upgrade can't leave a stale charset
    # (a wrong charset silently decodes wrong plates).
    for f in "$ANPR_SRC"/plateocr.labels "$ANPR_SRC"/anpr.meta.json; do
        [ -f "$f" ] && cp "$f" "$ANPR_DEST/"
    done
    echo "entrypoint: anpr models ready under $ANPR_DEST"
fi

# RF-DETR: seed ONNX exports + meta sidecars (dims/classes/labels).
RFDETR_SRC=/opt/fnvr/rfdetr
RFDETR_DEST=/var/lib/fnvr/models/rfdetr
mkdir -p "$RFDETR_DEST"
if [ -d "$RFDETR_SRC" ]; then
    for f in "$RFDETR_SRC"/*.onnx; do
        [ -f "$f" ] || continue
        dst="$RFDETR_DEST/$(basename "$f")"
        if ! cmp -s "$f" "$dst"; then
            cp -f "$f" "$dst"
            rm -f "${dst%.onnx}".onnx_b*_gpu0_*.engine
            echo "entrypoint: refreshed $(basename "$f") (+ dropped stale engines)"
        fi
    done
    for f in "$RFDETR_SRC"/*.meta.json; do
        [ -f "$f" ] && cp "$f" "$RFDETR_DEST/"
    done
    echo "entrypoint: rfdetr models ready under $RFDETR_DEST"
fi

# ---- Resolve detector settings & render nvinfer config ----
#
# Reads settings from the api via FNVR_SETTINGS_URL. If unreachable (api
# still starting, or single-service test), fall back to env defaults.
# Announces calibrating / compiling_engine states on NATS so the UI
# banner can explain the delay.

VARIANT="${FNVR_YOLO_VARIANT:-yolo26x}"
PRECISION="${FNVR_YOLO_PRECISION:-fp16}"
# Primary detector family: "rfdetr" (Roboflow RF-DETR, our custom
# parser; DEFAULT since the 2026-07-16 fleet A/B — 3x lower SM util,
# higher recall) or "yolo26" (DeepStream-Yolo parser, kept as fallback).
MODEL_FAMILY="${FNVR_MODEL_FAMILY:-rfdetr}"
RFDETR_VARIANT="${FNVR_RFDETR_VARIANT:-base}"
# Max nvinfer batch = max batched-mux group size. The supervisor chunks
# camera groups at FNVR_GROUP_MAX members; the (dynamic-batch) engine is
# built once at this max and serves every group size below it.
BATCH="${FNVR_GROUP_MAX:-8}"

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
        MF=$(echo "$SETTINGS_JSON" | sed -n 's/.*"model_family":"\([^"]*\)".*/\1/p')
        RV=$(echo "$SETTINGS_JSON" | sed -n 's/.*"rfdetr_variant":"\([^"]*\)".*/\1/p')
        IB=$(echo "$SETTINGS_JSON" | sed -n 's/.*"inference_backend":"\([a-z]*\)".*/\1/p')
        IV=$(echo "$SETTINGS_JSON" | sed -n 's/.*"interval":\([0-9]\+\).*/\1/p')
        A=$(echo "$SETTINGS_JSON" | sed -n 's/.*"anpr_enabled":\(true\|false\).*/\1/p')
        F=$(echo "$SETTINGS_JSON" | sed -n 's/.*"face_id_enabled":\(true\|false\).*/\1/p')
        [ -n "$V" ] && VARIANT="$V"
        [ -n "$P" ] && PRECISION="$P"
        [ -n "$MF" ] && MODEL_FAMILY="$MF"
        [ -n "$RV" ] && RFDETR_VARIANT="$RV"
        [ -n "$IV" ] && PGIE_INTERVAL="$IV"
        [ -n "$IB" ] && export FNVR_INFER_BACKEND="$IB"
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
# trtexec (see calibrate-yolo26.sh). Kept for parity with the Orin
# build; on Blackwell the FP8/NVFP4 quantisation path (tools/quant-onnx,
# Phase 3) supersedes INT8 calibration entirely. On any failure we fall
# back to FP16 so the container never crash-loops.
if [ "$PRECISION" = "int8" ]; then
    echo "entrypoint: note — INT8 calibration is legacy; prefer FP8/NVFP4 via tools/quant-onnx on Blackwell"
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

ENGINE_FILE="$YOLO_DEST/${VARIANT}.onnx_b${BATCH}_gpu0_${ENGINE_SUFFIX}.engine"
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

# Determine the class count for nvinfer. Stock yolo26 ONNXs have 80
# COCO outputs; custom fnvr-vN ONNXs have whatever the trainer wrote.
# We pull the *enabled-class count* from /admin/classes — it always
# matches the dataset.yaml the trainer used, so a custom ONNX trained
# on N classes pairs with num-detected-classes=N.
NUM_CLASSES="80"
case "$VARIANT" in
    fnvr-*)
        # Internal route (no auth) so the entrypoint doesn't need
        # to juggle login cookies. Returns the same JSON as
        # /api/v1/admin/classes.
        CLASSES_JSON=$(curl -s --max-time 5 "http://api:8081/api/v1/internal/classes" 2>/dev/null || true)
        if [ -n "$CLASSES_JSON" ]; then
            CC=$(printf '%s' "$CLASSES_JSON" | grep -oE '"enabled":true' | wc -l)
            if [ "$CC" -gt 0 ]; then
                NUM_CLASSES="$CC"
            fi
        fi
        ;;
esac
echo "entrypoint: num-detected-classes=$NUM_CLASSES"

# Render effective config into a writable location. /etc/fnvr is bind-
# mounted read-only from the host's deploy/config, so put the rendered
# file on the fnvr-data volume next to the models.
export MODEL="$VARIANT"
export BATCH NETWORK_MODE ENGINE_SUFFIX INT8_LINE NUM_CLASSES
EFFECTIVE_CFG="$YOLO_DEST/yolo26.effective.txt"
if command -v envsubst >/dev/null 2>&1; then
    envsubst '$MODEL $BATCH $NETWORK_MODE $ENGINE_SUFFIX $INT8_LINE $NUM_CLASSES' \
        < /etc/fnvr/nvinfer/yolo26.txt.template \
        > "$EFFECTIVE_CFG"
else
    sed \
        -e "s|\${BATCH}|$BATCH|g" \
        -e "s|\$BATCH|$BATCH|g" \
        -e "s|\$MODEL|$MODEL|g" \
        -e "s|\$NETWORK_MODE|$NETWORK_MODE|g" \
        -e "s|\$ENGINE_SUFFIX|$ENGINE_SUFFIX|g" \
        -e "s|\$INT8_LINE|$INT8_LINE|g" \
        -e "s|\$NUM_CLASSES|$NUM_CLASSES|g" \
        /etc/fnvr/nvinfer/yolo26.txt.template \
        > "$EFFECTIVE_CFG"
fi
if [ -n "${PGIE_INTERVAL:-}" ] && [ "${PGIE_INTERVAL}" != "0" ]; then
    sed -i "s/^interval=.*/interval=${PGIE_INTERVAL}/" "$EFFECTIVE_CFG"
fi

# ---- RF-DETR family: render its effective config from the export's
# meta.json sidecar (dims + class count are model truths, not config).
RFDETR_CFG=""
if [ "$MODEL_FAMILY" = "rfdetr" ]; then
    RFDETR_MODEL="rfdetr-${RFDETR_VARIANT}"
    META="$RFDETR_DEST/${RFDETR_MODEL}.meta.json"
    if [ -f "$META" ] && [ -f "$RFDETR_DEST/${RFDETR_MODEL}.onnx" ]; then
        RFDETR_W=$(python3 -c "import json;print(json.load(open('$META'))['input_w'])")
        RFDETR_H=$(python3 -c "import json;print(json.load(open('$META'))['input_h'])")
        RF_CLASSES=$(python3 -c "import json;print(json.load(open('$META'))['num_classes'])")
        python3 -c "import json;print('\n'.join(json.load(open('$META'))['labels']))" \
            > "$RFDETR_DEST/labels.txt"
        # (Person/vehicle class ids for the SGIE chains are computed
        # from this labels file in the family-aware SGIE render below.)
        RFDETR_CFG="$RFDETR_DEST/rfdetr.effective.txt"
        export MODEL="$RFDETR_MODEL" RFDETR_W RFDETR_H
        NUM_CLASSES="$RF_CLASSES"; export NUM_CLASSES
        if command -v envsubst >/dev/null 2>&1; then
            envsubst '$MODEL $BATCH $RFDETR_W $RFDETR_H $NUM_CLASSES' \
                < /etc/fnvr/nvinfer/rfdetr.txt.template > "$RFDETR_CFG"
        else
            sed -e "s|\${BATCH}|$BATCH|g" -e "s|\$BATCH|$BATCH|g" \
                -e "s|\$MODEL|$MODEL|g" \
                -e "s|\$RFDETR_W|$RFDETR_W|g" -e "s|\$RFDETR_H|$RFDETR_H|g" \
                -e "s|\$NUM_CLASSES|$NUM_CLASSES|g" \
                /etc/fnvr/nvinfer/rfdetr.txt.template > "$RFDETR_CFG"
        fi
        # Inference interval (settings detector.interval): skip pgie on
        # N of every N+1 frames — the tracker bridges. The relief
        # valve for high camera counts; 0 (default) = every frame.
        if [ -n "${PGIE_INTERVAL:-}" ] && [ "${PGIE_INTERVAL}" != "0" ]; then
            sed -i "s/^interval=.*/interval=${PGIE_INTERVAL}/" "$RFDETR_CFG"
            echo "entrypoint: pgie interval=${PGIE_INTERVAL}"
        fi
        echo "entrypoint: rfdetr family — $RFDETR_MODEL ${RFDETR_W}x${RFDETR_H} classes=$RF_CLASSES"
    else
        echo "entrypoint: WARNING model_family=rfdetr but $META missing — falling back to yolo26"
        MODEL_FAMILY="yolo26"
    fi
fi

# ---- Family-aware SGIE configs -------------------------------------
# scrfd (face detector) and platedet (plate detector) operate on class
# ids of the PRIMARY detector, and those ids depend on the family's
# label space: COCO-80 (yolo26) has person=0, vehicles=2;3;5;7, while
# RF-DETR's COCO-91 slot space puts them elsewhere. Render both configs
# with ids computed from the ACTIVE label file so the SGIEs can never
# silently run on the wrong classes.
PERSON_CLASS_ID=0
VEHICLE_CLASS_IDS="2;3;5;7"
if [ "$MODEL_FAMILY" = "rfdetr" ] && [ -f "$RFDETR_DEST/labels.txt" ]; then
    ids=$(python3 - "$RFDETR_DEST/labels.txt" <<'PYEOF'
import sys
labels = [l.rstrip("\n") for l in open(sys.argv[1])]
def idx(name):
    try: return labels.index(name)
    except ValueError: return -1
person = idx("person")
veh = [i for i in (idx("car"), idx("motorcycle"), idx("bus"), idx("truck")) if i >= 0]
print(person, ";".join(str(v) for v in veh))
PYEOF
)
    PERSON_CLASS_ID=$(echo "$ids" | cut -d" " -f1)
    VEHICLE_CLASS_IDS=$(echo "$ids" | cut -d" " -f2)
    if [ "$PERSON_CLASS_ID" = "-1" ]; then
        echo "entrypoint: WARNING no 'person' label in rfdetr space — disabling face-id"
        export FNVR_USE_FACEID=0
        PERSON_CLASS_ID=0
    fi
    [ -z "$VEHICLE_CLASS_IDS" ] && { echo "entrypoint: WARNING no vehicle labels — disabling ANPR"; export FNVR_USE_ANPR=0; VEHICLE_CLASS_IDS="0"; }
fi
mkdir -p /var/lib/fnvr/nvinfer
export PERSON_CLASS_ID VEHICLE_CLASS_IDS
for t in scrfd platedet; do
    if command -v envsubst >/dev/null 2>&1; then
        envsubst '$PERSON_CLASS_ID $VEHICLE_CLASS_IDS' \
            < "/etc/fnvr/nvinfer/${t}.txt.template" > "/var/lib/fnvr/nvinfer/${t}.txt"
    else
        sed -e "s|\$PERSON_CLASS_ID|$PERSON_CLASS_ID|g" \
            -e "s|\$VEHICLE_CLASS_IDS|$VEHICLE_CLASS_IDS|g" \
            "/etc/fnvr/nvinfer/${t}.txt.template" > "/var/lib/fnvr/nvinfer/${t}.txt"
    fi
done
echo "entrypoint: SGIE ids — person=$PERSON_CLASS_ID vehicles=$VEHICLE_CLASS_IDS"

# Pick the pgie config: rfdetr when selected and rendered, else the
# YOLO26 effective config, unless the operator pinned one via env.
if [ -z "$FNVR_INFER_CONFIG" ] || [ "$FNVR_INFER_CONFIG" = "/etc/fnvr/nvinfer/trafficcamnet.txt" ]; then
    if [ "$MODEL_FAMILY" = "rfdetr" ] && [ -n "$RFDETR_CFG" ]; then
        export FNVR_INFER_CONFIG="$RFDETR_CFG"
    elif [ -f /var/lib/fnvr/models/yolo26/"$VARIANT".onnx ]; then
        export FNVR_INFER_CONFIG="$EFFECTIVE_CFG"
    fi
fi

echo "entrypoint: family=$MODEL_FAMILY FNVR_INFER_CONFIG=$FNVR_INFER_CONFIG"

# DeepStream-Yolo's custom engine builder (NvDsInferYoloCudaEngineGet,
# wired via engine-create-func-name= in the nvinfer config) ignores
# the `model-engine-file=` setting when it WRITES the freshly-built
# engine — it dumps the binary into `$PWD/model_b1_gpu0_${suffix}.engine`
# regardless. nvinfer DOES honour model-engine-file= when reading,
# though, so the rebuild path on every container restart wastes
# ~8 min per camera on the first start. Background-rescue: poll for
# the stray file and rename it to the canonical model-engine-file
# path so the next container restart deserialises in 2 sec instead.
#
# Two safety properties:
#   - $YOLO_DEST is the persistent fnvr-data volume mount, so the
#     renamed file survives container recreate.
#   - We rename (not copy) so the watcher exits as soon as the work
#     is done; no growing process count.
EXPECTED_ENGINE="$YOLO_DEST/${VARIANT}.onnx_b${BATCH}_gpu0_${ENGINE_SUFFIX}.engine"
if [ ! -f "$EXPECTED_ENGINE" ]; then
    (
        # Workers build into PWD which is /src/apps/pipeline-supervisor
        # for an exec without chdir; explicit watch covers either
        # location in case of layout drift.
        for _ in $(seq 1 600); do  # up to 10 min
            for stray in \
                /src/apps/pipeline-supervisor/model_b${BATCH}_gpu0_${ENGINE_SUFFIX}.engine \
                ./model_b${BATCH}_gpu0_${ENGINE_SUFFIX}.engine \
                ; do
                if [ -f "$stray" ] && [ ! -f "$EXPECTED_ENGINE" ]; then
                    sleep 2  # tiny grace so the writer has flushed
                    mv "$stray" "$EXPECTED_ENGINE" \
                        && echo "entrypoint: cached engine -> $EXPECTED_ENGINE" \
                        && exit 0
                fi
            done
            sleep 1
        done
        echo "entrypoint: engine-rescue watcher gave up after 10 min"
    ) &
fi

exec /usr/local/bin/pipeline-supervisor "$@"
