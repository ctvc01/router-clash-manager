#!/bin/sh
# export_devices_info.sh - 在路由器上运行，输出设备信息为 JSON 格式
# 容器通过 SSH 执行此脚本获取设备名称和流量数据

# 构建输出 JSON
{
    echo "{"
    echo '  "devices": ['

    first=1
    cat /proc/net/arp | tail -n +2 | while IFS= read -r line; do
        # 解析 ARP 行：IP | HW | Flags | MAC | Mask | Device
        ip=$(echo "$line" | awk '{print $1}')
        mac=$(echo "$line" | awk '{print $4}' | tr '[:upper:]' '[:lower:]')
        device=$(echo "$line" | awk '{print $6}')

        # 过滤掉不合法的 MAC
        if ! echo "$mac" | grep -qE '^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$'; then
            continue
        fi

        # 查询 DHCP 租约文件获取 hostname
        hostname="未知设备"
        if [ -f /tmp/dhcp.leases ]; then
            hostname=$(grep "$mac" /tmp/dhcp.leases 2>/dev/null | awk '{print $4}' | head -1)
            [ -z "$hostname" ] && hostname="未知设备"
        fi

        # 查询设备状态 (如果可用)
        state="online"

        if [ $first -eq 1 ]; then
            first=0
        else
            echo ","
        fi

        echo "    {\"ip\": \"$ip\", \"mac\": \"$mac\", \"hostname\": \"$hostname\", \"device\": \"$device\", \"state\": \"$state\"}"
    done

    echo "  ]"
    echo "}"
}
