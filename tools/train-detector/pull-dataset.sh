#!/usr/bin/env bash
# Sync the fnvr-collected YOLO dataset off the Orin onto this training
# host. Re-runs are incremental (rsync); large image dirs only transfer
# what's new since the last pull.
#
# Usage:
#   ORIN=tim@172.16.4.23 ./pull-dataset.sh
# Or set FNVR_ORIN_HOST in the environment.
set -euo pipefail

ORIN="${ORIN:-${FNVR_ORIN_HOST:-tim@172.16.4.23}}"
SRC="/var/lib/docker/volumes/fnvr-data/_data/datasets/objects/"
DST="${1:-./dataset}"

mkdir -p "$DST"

# `sudo rsync` on the source side is needed because /var/lib/docker is
# root-owned. The Orin user has passwordless sudo.
exec rsync -avz --delete \
    --rsync-path="sudo rsync" \
    "${ORIN}:${SRC}" "${DST}/"
