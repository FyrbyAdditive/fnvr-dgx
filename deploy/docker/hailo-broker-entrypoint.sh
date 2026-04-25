#!/usr/bin/env sh
# hailo-broker container entrypoint: pick the HEF based on the
# `detector.hailo_model_version` setting, then exec the broker.
#
# Resolution:
#   "stock" (or unset)   → /var/lib/fnvr/models/hailo/yolov11l.hef
#   "<name>"             → /var/lib/fnvr/models/hailo/<name>.hef
#
# If the resolved file doesn't exist we log loudly and fall back to
# stock — the broker shouldn't refuse to start because the user
# pointed at a fine-tuned HEF that hasn't been rsynced over yet.
set -eu

MODELS_DIR="/var/lib/fnvr/models/hailo"
STOCK_HEF="${MODELS_DIR}/yolov11l.hef"

# Read the version from api-server. Use plain HTTP on the docker
# bridge — the broker container's on the same network. /system/info
# is already public; we use the internal/detector route which is
# also unauthenticated (server.go:134) precisely so internal
# containers can read settings without juggling cookies.
VERSION="$(wget -q -O - --timeout=3 \
    'http://api:8081/api/v1/internal/detector' 2>/dev/null \
    | sed -n 's/.*"hailo_model_version":"\([^"]*\)".*/\1/p')"

if [ -z "$VERSION" ] || [ "$VERSION" = "stock" ]; then
    HEF="$STOCK_HEF"
    echo "hailo-broker: using stock HEF: $HEF" >&2
else
    HEF="${MODELS_DIR}/${VERSION}.hef"
    if [ ! -f "$HEF" ]; then
        echo "hailo-broker: WARN requested version '$VERSION' missing at $HEF; falling back to stock" >&2
        HEF="$STOCK_HEF"
    else
        echo "hailo-broker: using fine-tuned HEF: $HEF" >&2
    fi
fi

if [ ! -f "$HEF" ]; then
    echo "hailo-broker: FATAL no HEF found at $HEF" >&2
    exit 1
fi

exec /usr/local/bin/fnvr-hailo-broker "$HEF"
