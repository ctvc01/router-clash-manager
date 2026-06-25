#!/bin/sh
# NAS-side TPROXY setup for game UDP
# Usage: setup_tproxy.sh

TPROXY_PORT="${1:-7893}"

# Create GAME_UDP chain
iptables -t mangle -F GAME_UDP 2>/dev/null
iptables -t mangle -X GAME_UDP 2>/dev/null
iptables -t mangle -N GAME_UDP 2>/dev/null

# TPROXY redirect to Clash
iptables -t mangle -A GAME_UDP -p udp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark 0x1

# Delete old hook rule if exists, then add
iptables -t mangle -D PREROUTING -p udp -j GAME_UDP 2>/dev/null
iptables -t mangle -A PREROUTING -p udp -j GAME_UDP

# Policy route: packets with mark 0x1 go to local
TABLE_ID=100
ip rule add fwmark 0x1 table $TABLE_ID 2>/dev/null
ip route replace local 0.0.0.0/0 dev lo table $TABLE_ID 2>/dev/null

# Enable route_localnet for TPROXY to work
sysctl -w net.ipv4.conf.all.route_localnet=1 2>/dev/null
sysctl -w net.ipv4.conf.lo.route_localnet=1 2>/dev/null

echo "TPROXY: UDP -> Clash port $TPROXY_PORT (fwmark 0x1)"
