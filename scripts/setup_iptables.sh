#!/bin/sh
# 透明代理 iptables 重建脚本
# 安全重建：先删除旧 REDIRECT 规则，再重建，确保幂等

WHITELIST="/data/ShellCrash/configs/mac"
REDIR_PORT="7892"

# 0. 清理旧的自定义链（如果存在）
iptables -t nat -D PREROUTING -j CLASH_PRE 2>/dev/null
iptables -t nat -F CLASH_PRE 2>/dev/null
iptables -t nat -X CLASH_PRE 2>/dev/null

# 1. 删除旧的 REDIRECT 规则（仅删除我们创建的，不碰系统规则）
iptables -t nat -D PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null
# 循环删除直到没有匹配（因为 -D 一次只删一条）
while iptables -t nat -C PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null; do
    iptables -t nat -D PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null
done

# 2. 确保 ESTABLISHED,RELATED 逃逸规则在最前面（防止转发流被重复劫持）
#    检查是否存在，不存在则插入到最前面
iptables -t nat -C PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || iptables -t nat -I PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# 3. 清理旧的 QUIC 阻断规则 (UDP 443 REJECT) - REJECT 只能在 filter 表的 FORWARD 链
while iptables -t filter -C FORWARD -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable 2>/dev/null; do
    iptables -t filter -D FORWARD -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable 2>/dev/null
done

# 4. 读取总白名单，为每个 MAC 创建 TCP REDIRECT 规则 (所有代理设备)
#    对每个设备，先添加一条跳过内网（192.168.31.0/24）的规则，避免代理设备无法访问 NAS 等内网服务
if [ -f "$WHITELIST" ]; then
    while read mac; do
        [ -z "$mac" ] && continue
        echo "$mac" | grep -q '^#' && continue
        mac=$(echo "$mac" | tr 'a-z' 'A-Z')
        # 跳过内网网段（设备访问 NAS 等内网服务不被劫持）
        LAN_SUBNET="192.168.31.0/24"
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d "$LAN_SUBNET" -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d "$LAN_SUBNET" -p tcp -j RETURN
        # 检查 REDIRECT 规则是否已存在，不存在则添加
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT"
    done < "$WHITELIST"
fi
# 5. 读取 AI 设备白名单，针对 AI 设备阻断 QUIC (UDP 443) 以强制降级 TCP
AI_WHITELIST="/data/ShellCrash/configs/ai_devices"
if [ -f "$AI_WHITELIST" ]; then
    while read mac; do
        [ -z "$mac" ] && continue
        echo "$mac" | grep -q '^#' && continue
        mac=$(echo "$mac" | tr 'a-z' 'A-Z')
        # 添加 UDP 443 阻断规则 (于 filter 表的 FORWARD 链)，强制浏览器秒级降级 TCP
        iptables -t filter -C FORWARD -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable 2>/dev/null \
            || iptables -t filter -I FORWARD 1 -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable
    done < "$AI_WHITELIST"
fi

RULE_COUNT=$(iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c "redir ports $REDIR_PORT" || echo 0)
QUIC_COUNT=$(iptables -t filter -L FORWARD -n 2>/dev/null | grep -c "udp dpt:443" || echo 0)
echo "iptables: $RULE_COUNT TCP REDIRECT rules in PREROUTING, $QUIC_COUNT UDP REJECT rules in FORWARD"
