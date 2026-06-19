#!/bin/sh
# SSH wrapper using sshpass for reliable password authentication

IP="${ROUTER_IP:-192.168.31.1}"
USER="${ROUTER_USER:-root}"
PASSWORD="${ROUTER_PASSWORD:-}"

if [ -z "$PASSWORD" ]; then
    echo "Error: ROUTER_PASSWORD not set" >&2
    exit 1
fi

if [ $# -lt 1 ]; then
    echo "Usage: $0 <command>"
    exit 1
fi

CMD="$1"

# Use sshpass with SSH to provide password automatically
export SSHPASS="$PASSWORD"

# Execute with better error handling
sshpass -e ssh \
    -o StrictHostKeyChecking=no \
    -o HostKeyAlgorithms=+ssh-rsa \
    -o PubkeyAcceptedKeyTypes=+ssh-rsa \
    -o BatchMode=no \
    -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=no \
    "$USER@$IP" \
    "$CMD" 2>&1

# Preserve the exit code
exit $?
