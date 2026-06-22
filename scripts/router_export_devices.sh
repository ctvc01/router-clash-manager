#!/bin/sh
# 在路由器上定期执行，收集设备信息并导出为 JSON 文件
# 这样容器可以通过 SSH 读取设备名称和流量数据

OUTPUT_FILE="/tmp/devices_info.json"

# 获取 ARP 表
arp_data=$(cat /proc/net/arp | tail -n +2)

# 获取 DHCP 租约或设备名称信息
# Xiaomi 路由器可能在 /tmp/dhcp.leases 或其他地方
if [ -f /tmp/dhcp.leases ]; then
    dhcp_data=$(cat /tmp/dhcp.leases)
elif [ -f /var/lib/misc/dnsmasq.leases ]; then
    dhcp_data=$(cat /var/lib/misc/dnsmasq.leases)
else
    dhcp_data=""
fi

# 尝试获取流量数据 (本地 ubus 调用)
if command -v ubus >/dev/null 2>&1; then
    traffic_data=$(ubus call trafficd hw 2>/dev/null || echo "{}")
else
    traffic_data="{}"
fi

# 组合数据为 JSON
cat > "$OUTPUT_FILE" << EOF
{
  "arp": "$(echo "$arp_data" | sed 's/"/\\"/g')",
  "dhcp": "$(echo "$dhcp_data" | sed 's/"/\\"/g')",
  "traffic": $traffic_data,
  "timestamp": $(date +%s)
}
EOF

echo "Device info exported to $OUTPUT_FILE"
