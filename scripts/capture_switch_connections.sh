#!/bin/sh
# Capture live Switch connections from the Clash API.
# Usage: DURATION=180 ./scripts/capture_switch_connections.sh
# Requires ROUTER_PASSWORD / CLASH_PORT from .env or environment.

set -u

ROUTER_IP="${ROUTER_IP:-192.168.31.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"
CLASH_PORT="${CLASH_PORT:-9999}"
SWITCH_MAC="${SWITCH_MAC:-40:44:f7:0c:bd:9e}"
SWITCH_IP="${SWITCH_IP:-}"
DURATION="${DURATION:-300}"
INTERVAL="${INTERVAL:-1}"

if [ -f ./.env ]; then
    if [ -z "$ROUTER_IP" ]; then
        ROUTER_IP=$(grep '^ROUTER_IP=' ./.env | tail -1 | sed 's/^ROUTER_IP=//; s/^"//; s/"$//')
    fi
    if [ -z "$ROUTER_USER" ]; then
        ROUTER_USER=$(grep '^ROUTER_USER=' ./.env | tail -1 | sed 's/^ROUTER_USER=//; s/^"//; s/"$//')
    fi
    if [ -z "$ROUTER_PASSWORD" ]; then
        ROUTER_PASSWORD=$(grep '^ROUTER_PASSWORD=' ./.env | tail -1 | sed 's/^ROUTER_PASSWORD=//; s/^"//; s/"$//')
    fi
    if [ -z "$CLASH_PORT" ]; then
        CLASH_PORT=$(grep '^CLASH_PORT=' ./.env | tail -1 | sed 's/^CLASH_PORT=//; s/^"//; s/"$//')
    fi
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa"
if [ -z "$SWITCH_IP" ]; then
    if [ -z "$ROUTER_PASSWORD" ]; then
        echo "[ERROR] ROUTER_PASSWORD not set and SWITCH_IP not provided" >&2
        exit 1
    fi
    SWITCH_IP=$(sshpass -p "$ROUTER_PASSWORD" ssh $SSH_OPTS "${ROUTER_USER}@${ROUTER_IP}" \
        "grep -i '$SWITCH_MAC' /tmp/dhcp.leases /var/dhcp.leases 2>/dev/null | awk '{print \$3}' | head -1" 2>/dev/null | tr -d '\r')
fi

if [ -z "$SWITCH_IP" ]; then
    echo "[ERROR] Switch IP not found for MAC $SWITCH_MAC, set SWITCH_IP explicitly" >&2
    exit 1
fi

OUT_DIR="logs"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/switch_connections_$(date +%Y%m%d_%H%M%S).log"
API="http://${ROUTER_IP}:${CLASH_PORT}"

echo "[INFO] Capturing connections from $SWITCH_IP for ${DURATION}s -> $OUT_FILE"
END=$(( $(date +%s) + DURATION ))

while [ "$(date +%s)" -lt "$END" ]; do
    RAW=$(curl -s --max-time 3 "$API/connections" 2>/dev/null)
    if [ -n "$RAW" ]; then
        TOTAL=$(printf '%s\n' "$RAW" | sed -n 's/.*"downloadTotal":\([0-9]*\).*/\1/p' | head -1)
        if [ -n "$TOTAL" ]; then
            echo "$(date '+%Y-%m-%d %H:%M:%S') | downloadTotal=$TOTAL" >> "$OUT_FILE"
        fi
        printf '%s\n' "$RAW" | tr '}' '\n' | \
            grep "\"sourceIP\":\"${SWITCH_IP}\"" | while IFS= read -r line; do
                echo "$(date '+%Y-%m-%d %H:%M:%S') | $line" >> "$OUT_FILE"
            done
    fi
    sleep "$INTERVAL"
done

echo "[INFO] Done. File: $OUT_FILE"
echo "Nintendo hits:"
grep -i "nintendo\|atum\|ctest\|hac\.lp1\|eshop\|download\.nintendo" "$OUT_FILE" 2>/dev/null | head -50 || true
