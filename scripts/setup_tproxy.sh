#!/bin/sh
# NAS-side TPROXY setup for game UDP
# Usage: setup_tproxy.sh [tproxy_port] <game_ip1> [game_ip2...]

TPROXY_PORT="${1:-7893}"
# Check if first arg is a port (number) or an IP
if echo "$TPROXY_PORT" | grep -qE '^[0-9]+$'; then
    shift
else
    TPROXY_PORT=7893
fi
GAME_IPS="$@"

if [ -z "$GAME_IPS" ]; then
    echo "TPROXY: no game IPs provided, skipping PREROUTING hook"
    exit 0
fi

# Create GAME_UDP chain
iptables -t mangle -F GAME_UDP 2>/dev/null
iptables -t mangle -X GAME_UDP 2>/dev/null
iptables -t mangle -N GAME_UDP 2>/dev/null

# TPROXY redirect to Clash
iptables -t mangle -A GAME_UDP -p udp -j TPROXY --on-port "$TPROXY_PORT" --tproxy-mark 0x1

# Hook into PREROUTING only for game device IPs
iptables -t mangle -D PREROUTING -m udp -j GAME_UDP 2>/dev/null
for ip in $GAME_IPS; do
    iptables -t mangle -D PREROUTING -s "$ip" -p udp -j GAME_UDP 2>/dev/null
    iptables -t mangle -A PREROUTING -s "$ip" -p udp -j GAME_UDP
    echo "TPROXY hook: $ip -> Clash:$TPROXY_PORT"
done

# Policy route: packets with mark 0x1 go to local
TABLE_ID=100
ip rule add fwmark 0x1 table $TABLE_ID 2>/dev/null
ip route replace local 0.0.0.0/0 dev lo table $TABLE_ID 2>/dev/null

sysctl -w net.ipv4.conf.all.route_localnet=1 2>/dev/null
sysctl -w net.ipv4.conf.lo.route_localnet=1 2>/dev/null

echo "TPROXY: UDP -> Clash port $TPROXY_PORT (fwmark 0x1)"
