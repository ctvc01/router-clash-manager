#!/bin/sh
# Router Clash Manager - 防火墙与进程存活联动降级守护脚本
# 运行环境: 路由器 OpenWrt / BusyBox

# 后台无限死循环守护，每 10 秒巡检一次进程状态
while true; do
    # 检查 Clash 核心进程是否存活 (兼容 mihomo 和 Clash 二进制)
    CLASH_PID=$(pidof mihomo || pidof Clash)

    if [ -z "$CLASH_PID" ]; then
        # 核心进程不存在，需要检查引流防火墙规则是否仍在生效
        if iptables -t nat -C PREROUTING -p tcp -j PREROUTING_RULES 2>/dev/null; then
            # 卸载透明代理引流，平滑降级为 DIRECT 直连，防止局域网设备断网
            iptables -t nat -D PREROUTING -p tcp -j PREROUTING_RULES
        fi
    else
        # 核心进程已正常运行，确保引流已自动挂载
        if ! iptables -t nat -C PREROUTING -p tcp -j PREROUTING_RULES 2>/dev/null; then
            # 如果重定向自定义链存在，则重新加挂
            if iptables -t nat -L PREROUTING_RULES >/dev/null 2>&1; then
                iptables -t nat -I PREROUTING -p tcp -j PREROUTING_RULES
            fi
        fi
    fi
    
    sleep 10
done
