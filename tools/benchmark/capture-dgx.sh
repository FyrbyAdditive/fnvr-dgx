#!/bin/bash
# capture-dgx.sh — fnvr benchmark capture for DGX Spark (GB10).
# Replaces the Orin's tegrastats/actmon collection. Run ON the Spark:
#   ./capture-dgx.sh <label> [sample-seconds]
# Writes tools/benchmark-style sections to stdout; redirect to a file.
#
# Sections mirror the 2026-05-03 Orin baseline so results stay
# longitudinally comparable: engine load, memory, per-camera pipeline
# rate, detection-processing counters, Postgres insert rate, camera
# config snapshot.
set -euo pipefail

LABEL="${1:?usage: capture-dgx.sh <label> [seconds]}"
SECS="${2:-60}"
PG() { sudo docker exec fnvr-postgres-1 psql -U fnvr -d fnvr -t -A -c "$1"; }

echo "fnvr-dgx capture — label=$LABEL — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host=$(hostname) kernel=$(uname -r) driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader)"
echo
echo "================================================================================"
echo "SECTION 1 — GPU engine load (nvidia-smi dmon, ${SECS}s @ 1Hz)"
echo "columns: gpu sm mem enc dec jpg ofa (percent)"
nvidia-smi dmon -s u -d 1 -c "$SECS" | grep -vE '^#' \
  | awk '{sm+=$2; mem+=$3; enc+=$4; dec+=$5; n++;
          if($2>smx)smx=$2; if($5>dcx)dcx=$5}
         END{printf "  SM   mean %.1f%%  max %d%%\n  MEM  mean %.1f%%\n  ENC  mean %.1f%%\n  DEC  mean %.1f%%  max %d%%\n", sm/n, smx, mem/n, enc/n, dec/n, dcx}'
echo
echo "  power/temp snapshot:"
nvidia-smi --query-gpu=power.draw,temperature.gpu,clocks.sm --format=csv,noheader | sed 's/^/    /'
echo
echo "================================================================================"
echo "SECTION 2 — system memory + pipeline processes"
free -g | sed 's/^/  /'
echo
echo "  pipeline worker processes:"
sudo docker exec fnvr-pipeline-1 ps -eo pid,rss,args --sort=-rss 2>/dev/null \
  | grep -E 'pipeline-supervisor' | grep -v grep | sed 's/^/    /'
echo
echo "================================================================================"
echo "SECTION 3 — per-camera pipeline buffer rate (latest probe heartbeats)"
sudo docker logs fnvr-pipeline-1 --since 10m 2>&1 \
  | grep -E '^probe\[' | tail -20 | sed 's/^/  /'
echo
echo "================================================================================"
echo "SECTION 4 — detection throughput"
echo "  detections rows by camera, last 10 min:"
PG "SELECT camera_id, count(*) FROM detections WHERE ts > now() - interval '10 minutes' GROUP BY 1 ORDER BY 2 DESC" | sed 's/^/    /'
echo "  insert rate (rows/sec over last 5 min):"
PG "SELECT round(count(*)/300.0, 1) FROM detections WHERE ts > now() - interval '5 minutes'" | sed 's/^/    /'
echo
echo "================================================================================"
echo "SECTION 5 — camera config snapshot"
PG "SELECT id, enabled, array_to_string(enabled_detectors,'+') AS detectors, rotation, mtx_proxy FROM cameras ORDER BY id" | sed 's/^/  /'
echo
echo "================================================================================"
echo "SECTION 6 — engine cache"
sudo docker exec fnvr-pipeline-1 ls -la /var/lib/fnvr/models/yolo26/ 2>/dev/null | grep -E '\.engine' | sed 's/^/  /'
