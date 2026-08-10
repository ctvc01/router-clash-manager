#!/bin/sh
# 定向转发 Switch 下载 CDN 域名到 Clash DNS(1053)，联机/NAT 域保持真实 IP 直连。
# 用途：修复游戏模式下 Switch NAT 类型掉到 F（联机/NAT 域被 fake-ip 黑洞），
#       同时保留下载 CDN 走代理加速（fake-ip -> 游戏下载组）。
# 用法：
#   ./scripts/setup_switch_dns.sh          # 应用（幂等）
#   ./scripts/setup_switch_dns.sh revert   # 回退（移除全部 nintendo 定向转发）
# 依赖：ROUTER_PASSWORD（.env 或环境变量）、路由器 sshpass 密码认证。

set -u

ROUTER_IP="${ROUTER_IP:-192.168.31.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"

if [ -f ./.env ]; then
    [ -z "$ROUTER_IP" ] && ROUTER_IP=$(grep '^ROUTER_IP=' ./.env | tail -1 | sed 's/^ROUTER_IP=//; s/^"//; s/"$//')
    [ -z "$ROUTER_USER" ] && ROUTER_USER=$(grep '^ROUTER_USER=' ./.env | tail -1 | sed 's/^ROUTER_USER=//; s/^"//; s/"$//')
    [ -z "$ROUTER_PASSWORD" ] && ROUTER_PASSWORD=$(grep '^ROUTER_PASSWORD=' ./.env | tail -1 | sed 's/^ROUTER_PASSWORD=//; s/^"//; s/"$//')
fi

if [ -z "$ROUTER_PASSWORD" ]; then
    echo "[ERROR] ROUTER_PASSWORD not set" >&2
    exit 1
fi

ACTION="${1:-apply}"

case "$ACTION" in
    apply)
        REMOTE="$(cat <<'REMOTE_EOF'
set -e
# 1. 移除历史整域转发（如有），避免联机/NAT 域被 fake-ip 黑洞
uci -q del_list dhcp.@dnsmasq[0].server=/nintendo.net/127.0.0.1#1053
# 2. 幂等追加收窄后的下载 CDN 子域转发
for d in d4c.srv.nintendo.net penne.srv.nintendo.net download.nintendo.net; do
    entry="/${d}/127.0.0.1#1053"
    if ! uci -q get dhcp.@dnsmasq[0].server | grep -q "$entry"; then
        uci -q add_list dhcp.@dnsmasq[0].server="$entry"
    fi
done
uci commit dhcp
/etc/init.d/dnsmasq restart
echo "=== dnsmasq server after apply ==="
uci show dhcp | grep -i "server=" || true
REMOTE_EOF
)"
        ;;
    revert)
        REMOTE="$(cat <<'REMOTE_EOF'
set -e
for d in d4c.srv.nintendo.net penne.srv.nintendo.net download.nintendo.net nintendo.net; do
    uci -q del_list dhcp.@dnsmasq[0].server="/${d}/127.0.0.1#1053"
done
uci commit dhcp
/etc/init.d/dnsmasq restart
echo "=== dnsmasq server after revert ==="
uci show dhcp | grep -i "server=" || true
REMOTE_EOF
)"
        ;;
    *)
        echo "[ERROR] unknown action: $ACTION (apply|revert)" >&2
        exit 1
        ;;
esac

SSH_OPTS="-o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa"
sshpass -p "$ROUTER_PASSWORD" ssh $SSH_OPTS -o ConnectTimeout=8 "${ROUTER_USER}@${ROUTER_IP}" "$REMOTE"
exit $?
