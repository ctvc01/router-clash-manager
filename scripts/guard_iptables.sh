#!/bin/sh
# Router Clash Manager - 防火墙与进程存活联动降级守护脚本
# 运行环境: 路由器 OpenWrt / BusyBox

# 后台无限死循环守护，每 10 秒巡检一次进程状态
while true; do
    # 检查 Clash 核心进程是否存活 (兼容 mihomo 和 Clash 二进制)
    CLASH_PID=$(pidof mihomo || pidof Clash)

    if [ -z "$CLASH_PID" ]; then
        # 核心进程不存在，卸载透明代理引流，平滑降级为 DIRECT 直连，防止局域网设备断网
        # 1. 清理指定端口 (7892) 的 TCP REDIRECT 规则
        while iptables -t nat -C PREROUTING -p tcp -j REDIRECT --to-ports 7892 2>/dev/null; do
            iptables -t nat -D PREROUTING -p tcp -j REDIRECT --to-ports 7892 2>/dev/null
        done
        # 2. 清理官方 PREROUTING_RULES 自定义链引流（如有）
        if iptables -t nat -C PREROUTING -p tcp -j PREROUTING_RULES 2>/dev/null; then
            iptables -t nat -D PREROUTING -p tcp -j PREROUTING_RULES 2>/dev/null
        fi
    else
        # 核心进程已正常运行，确保引流已自动挂载
        if ! iptables -t nat -C PREROUTING -p tcp -j REDIRECT --to-ports 7892 2>/dev/null; then
            if [ -f /data/ShellCrash/setup_iptables.sh ]; then
                /bin/sh /data/ShellCrash/setup_iptables.sh >/dev/null 2>&1
            elif iptables -t nat -L PREROUTING_RULES >/dev/null 2>&1; then
                iptables -t nat -I PREROUTING -p tcp -j PREROUTING_RULES 2>/dev/null
            fi
        fi
    fi
    
    sleep 10
done
