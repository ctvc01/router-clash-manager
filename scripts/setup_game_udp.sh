#!/bin/sh
# Game UDP TPROXY routing: redirect game device UDP to NAS for Full Cone NAT
# Router-side: policy routes game device IPs to NAS
# Usage: setup_game_udp.sh <NAS_IP> <GAME_IP1> [GAME_IP2...]

NAS_IP="${1}"
shift

if [ -z "$NAS_IP" ]; then
    echo "Usage: $0 <NAS_IP> <GAME_IP1> [GAME_IP2...]"
    exit 1
fi

TABLE_ID=100

# Create policy routing for game device IPs
ip route add default via "$NAS_IP" dev br-lan table $TABLE_ID 2>/dev/null

for ip in "$@"; do
    [ -z "$ip" ] && continue
    ip rule del from "$ip" table $TABLE_ID 2>/dev/null
    ip rule add from "$ip" table $TABLE_ID
    echo "game_udp: $ip -> NAS $NAS_IP"
done
