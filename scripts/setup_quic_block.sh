#!/bin/sh
# QUIC (UDP 443) 阻断脚本
# 强制浏览器 / App 从 QUIC 回退到 TCP，防止 UDP 443 绕过透明代理
#
# 规则放在 forwarding_rule 链（OpenWrt 自定义转发链），在 zone_lan_forward 之前执行
# 只匹配白名单中的设备 MAC

WHITELIST="/data/ShellCrash/configs/mac"

if [ ! -f "$WHITELIST" ]; then
    echo "QUIC block: whitelist not found, skipping"
    exit 0
fi

# 确保 forwarding_rule 链存在
iptables -N forwarding_rule 2>/dev/null

# 删除旧的 QUIC 阻断规则
while iptables -C forwarding_rule -p udp --dport 443 -j REJECT 2>/dev/null; do
    iptables -D forwarding_rule -p udp --dport 443 -j REJECT 2>/dev/null
done

# 为每个白名单设备创建 QUIC 阻断规则
COUNT=0
while read mac; do
    [ -z "$mac" ] && continue
    echo "$mac" | grep -q '^#' && continue
    mac=$(echo "$mac" | tr 'a-z' 'A-Z')
    iptables -C forwarding_rule -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable 2>/dev/null \
        || iptables -A forwarding_rule -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable
    COUNT=$((COUNT + 1))
done < "$WHITELIST"

echo "QUIC block: $COUNT devices blocked on UDP 443"
