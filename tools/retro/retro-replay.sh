#!/bin/bash
# Retro-analytics runner — replay recorded footage through the current
# detector stack, backfilling detections with historical timestamps.
#
# Run INSIDE the pipeline container (the replay binary, engines and
# recordings all live there):
#
#   sudo docker exec -e FNVR_USE_ANPR=1 -e FNVR_USE_FACEID=1 \
#       fnvr-pipeline-1 bash /etc/fnvr/../..//usr/local/bin/retro-replay.sh \
#       <camera_id> [since-date] [until-date]
#
#   camera_id   e.g. cam-house-back  (recordings under live_<camera_id>)
#   since/until YYYY-MM-DD bounds on recording filenames (optional)
#
# Behaviour:
#   * Walks /var/lib/fnvr/recordings/live_<cam>/*.mp4 oldest-first.
#   * GPU-polite: before each file, waits until SM util < FNVR_RETRO_SM_MAX
#     (default 50 %) so live inference and push legs never starve —
#     GPU contention provably degrades the fleet's relays.
#   * Resumable: done-files are recorded in
#     /var/lib/fnvr/retro/<cam>.done; re-runs skip them.
#   * Detections publish on fnvr.events.retro_detection.<cam> with
#     ts = filename start + pts; event-processor stores them without
#     firing alarm/notification rules.
set -u

CAM="${1:?usage: retro-replay.sh <camera_id> [since YYYY-MM-DD] [until YYYY-MM-DD]}"
SINCE="${2:-0000-00-00}"
UNTIL="${3:-9999-99-99}"
SM_MAX="${FNVR_RETRO_SM_MAX:-50}"
REC="/var/lib/fnvr/recordings/live_${CAM}"
STATE_DIR="/var/lib/fnvr/retro"
DONE="${STATE_DIR}/${CAM}.done"
mkdir -p "$STATE_DIR"
touch "$DONE"

[ -d "$REC" ] || { echo "retro: no recordings dir $REC"; exit 1; }

gpu_sm() {
    local v
    v=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits \
        2>/dev/null | head -1 | tr -d '[:space:]')
    # Default empty → 0: when nvidia-smi is absent/erroring, head still
    # exits 0 on empty input, and an empty string breaks the -ge/-lt
    # gates below (a paused replay would then never resume).
    echo "${v:-0}"
}

total=0 done_n=0 skip_n=0 fail_n=0
for f in $(find "$REC" -name '*.mp4' | sort); do
    base=$(basename "$f" .mp4)          # 2026-07-16_18-00-00-123456
    day="${base%%_*}"
    [ "$day" \< "$SINCE" ] && continue
    [ "$day" \> "$UNTIL" ] && continue
    total=$((total+1))
    if grep -qxF "$base" "$DONE"; then skip_n=$((skip_n+1)); continue; fi

    # Parse start time from the filename → epoch ms.
    ts_part="${base#*_}"                # 18-00-00-123456
    hms="${ts_part%-*}"                 # 18-00-00
    epoch=$(date -u -d "${day} ${hms//-/:}" +%s 2>/dev/null) || {
        echo "retro: unparseable filename $base — skipping"; continue; }
    base_ms=$((epoch * 1000))

    # GPU politeness gate.
    while [ "$(gpu_sm)" -ge "$SM_MAX" ]; do
        echo "retro: GPU busy ($(gpu_sm)% >= ${SM_MAX}%) — waiting 30s"
        sleep 30
    done

    echo "retro[$CAM]: $base"
    /usr/local/bin/pipeline-supervisor --worker-replay \
        "$CAM" "$f" "$base_ms" &
    RPID=$!
    # Mid-file throttling: the between-files gate is useless once a
    # long segment is replaying — an unthrottled replay measurably
    # starves the live push relays (2026-07-17 incident). Pause the
    # replay (SIGSTOP) whenever live SM is above the ceiling and
    # resume when it drops.
    paused=0
    while kill -0 "$RPID" 2>/dev/null; do
        sleep 5
        sm=$(gpu_sm)
        if [ "$sm" -ge "$SM_MAX" ] && [ "$paused" = "0" ]; then
            kill -STOP "$RPID" 2>/dev/null && paused=1
            echo "retro[$CAM]: paused (SM ${sm}% >= ${SM_MAX}%)"
        elif [ "$sm" -lt "$SM_MAX" ] && [ "$paused" = "1" ]; then
            kill -CONT "$RPID" 2>/dev/null && paused=0
            echo "retro[$CAM]: resumed (SM ${sm}%)"
        fi
    done
    if wait "$RPID"; then
        echo "$base" >> "$DONE"
        done_n=$((done_n+1))
    else
        echo "retro[$CAM]: FAILED $base (rc=$?)"
        fail_n=$((fail_n+1))
    fi
done
echo "retro[$CAM]: complete — $done_n replayed, $skip_n already done, $fail_n failed (of $total in range)"
