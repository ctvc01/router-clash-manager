#!/bin/sh
# 透明代理 iptables 重建脚本
# 安全重建：先删除旧 REDIRECT 规则，再重建，确保幂等

WHITELIST="/data/ShellCrash/configs/mac"
REDIR_PORT="7892"

# 0. 清理旧的自定义链（如果存在）
iptables -t nat -D PREROUTING -j CLASH_PRE 2>/dev/null
iptables -t nat -F CLASH_PRE 2>/dev/null
iptables -t nat -X CLASH_PRE 2>/dev/null

# 0b. 调优 Linux TCP 接收窗口与 socket 缓冲区 (最大 4MB 动态可回收窗口，提升多线程下行吞吐)
echo 4194304 > /proc/sys/net/core/rmem_max 2>/dev/null
echo 4194304 > /proc/sys/net/core/wmem_max 2>/dev/null
echo "4096 87380 4194304" > /proc/sys/net/ipv4/tcp_rmem 2>/dev/null
echo "4096 65536 4194304" > /proc/sys/net/ipv4/tcp_wmem 2>/dev/null

# 0c. 按设备 DNS 劫持：仅对白名单/游戏/AI 加速设备强制 53→1053 (Fake-IP)
#     非白名单设备保持 dnsmasq 真实 IP 直连，避免全局 fake-ip 黑洞导致网页无法打开
DNS_REDIR_PORT="1053"
# 清理历史全局 DNS 劫持规则（旧版误伤所有设备，是"网页打不开"的根因）
iptables -t nat -D PREROUTING -p udp --dport 53 -j REDIRECT --to-ports "$DNS_REDIR_PORT" 2>/dev/null
iptables -t nat -D PREROUTING -p tcp --dport 53 -j REDIRECT --to-ports "$DNS_REDIR_PORT" 2>/dev/null
# 幂等重建按设备劫持链（CLASH_DNS 仅含加速设备 MAC 的规则，未命中自动返回）
iptables -t nat -N CLASH_DNS 2>/dev/null
iptables -t nat -F CLASH_DNS
for mac in $(cat "$WHITELIST" /data/ShellCrash/configs/game_devices /data/ShellCrash/configs/ai_devices 2>/dev/null | tr 'a-z' 'A-Z' | sort -u); do
    [ -z "$mac" ] && continue
    echo "$mac" | grep -q '^#' && continue
    iptables -t nat -A CLASH_DNS -m mac --mac-source "$mac" -p udp --dport 53 -j REDIRECT --to-ports "$DNS_REDIR_PORT"
    iptables -t nat -A CLASH_DNS -m mac --mac-source "$mac" -p tcp --dport 53 -j REDIRECT --to-ports "$DNS_REDIR_PORT"
done
iptables -t nat -D PREROUTING -j CLASH_DNS 2>/dev/null
iptables -t nat -I PREROUTING 1 -j CLASH_DNS

# 1. 删除旧的透明代理 REDIRECT 规则（含按 MAC 规则，防止白名单缩减后残留劫持）
iptables -t nat -S PREROUTING 2>/dev/null | grep "REDIRECT --to-ports $REDIR_PORT" | while read -r rule; do
    iptables -t nat -D PREROUTING ${rule#-A PREROUTING } 2>/dev/null
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
        # 跳过内网与国内主要 IP 网段（防止国内直连流量被 Clash 误处理导致 SSL_ERROR_SYSCALL）
        LAN_SUBNET="192.168.31.0/24"
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d "$LAN_SUBNET" -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d "$LAN_SUBNET" -p tcp -j RETURN
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d 10.0.0.0/8 -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d 10.0.0.0/8 -p tcp -j RETURN
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d 172.16.0.0/12 -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d 172.16.0.0/12 -p tcp -j RETURN
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d 223.5.5.5 -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d 223.5.5.5 -p tcp -j RETURN
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d 119.29.29.29 -p tcp -j RETURN 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d 119.29.29.29 -p tcp -j RETURN

        # 中国主要运营商 IP 段绕过 (百度/阿里/腾讯/国内全网直连不进 Clash)
        for china_cidr in 180.0.0.0/7 112.0.0.0/5 120.0.0.0/6 220.0.0.0/6 58.0.0.0/7 60.0.0.0/7 101.0.0.0/8 106.0.0.0/8 119.0.0.0/8 114.0.0.0/8; do
            iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -d "$china_cidr" -p tcp -j RETURN 2>/dev/null \
                || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -d "$china_cidr" -p tcp -j RETURN
        done

        # 检查 REDIRECT 规则是否已存在，不存在则添加
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT"
    done < "$WHITELIST"
fi
# 5. 读取 AI 设备与游戏设备白名单，针对特定设备阻断 QUIC (UDP 443) 以强制降级 TCP
AI_WHITELIST="/data/ShellCrash/configs/ai_devices"
GAME_WHITELIST="/data/ShellCrash/configs/game_devices"
for wl_file in "$AI_WHITELIST" "$GAME_WHITELIST"; do
    if [ -f "$wl_file" ]; then
        while read mac; do
            [ -z "$mac" ] && continue
            echo "$mac" | grep -q '^#' && continue
            mac=$(echo "$mac" | tr 'a-z' 'A-Z')
            # 添加 UDP 443 阻断规则 (于 filter 表的 FORWARD 链)，强制大文件下载秒级降级双通道 TCP
            iptables -t filter -C FORWARD -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable 2>/dev/null \
                || iptables -t filter -I FORWARD 1 -m mac --mac-source "$mac" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable
        done < "$wl_file"
    fi
done

RULE_COUNT=$(iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c "redir ports $REDIR_PORT" || echo 0)
QUIC_COUNT=$(iptables -t filter -L FORWARD -n 2>/dev/null | grep -c "udp dpt:443" || echo 0)
echo "iptables: $RULE_COUNT TCP REDIRECT rules in PREROUTING, $QUIC_COUNT UDP REJECT rules in FORWARD"
