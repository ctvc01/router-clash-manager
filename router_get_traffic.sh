#!/bin/sh
# 通过 iptables 获取设备流量统计信息
# 输出 JSON 格式的流量数据

output_json() {
    local first=1
    echo "{"

    # 从 iptables 中提取流量统计
    iptables -t mangle -L -v -x 2>/dev/null | grep -E 'FORWARD|policy|Chain' | while read line; do
        # 尝试提取 IP 和字节数
        # 这是一个示例，实际需要根据 iptables 规则进行定制
        :
    done

    # 如果 iptables 不可用，尝试用 tc 命令
    tc filter show dev br-lan root 2>/dev/null | while read line; do
        # 解析 tc 输出
        :
    done

    echo "}"
}

# 简化版本：直接返回 ARP 表中的设备（流量全部为0）
echo "{"
echo '  "devices": ['
first=1
cat /proc/net/arp | tail -n +2 | while IFS= read -r line; do
    ip=$(echo "$line" | awk '{print $1}')
    mac=$(echo "$line" | awk '{print $4}' | tr '[:upper:]' '[:lower:]')

    # 验证 MAC 格式
    if echo "$mac" | grep -qE '^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$'; then
        if [ $first -eq 1 ]; then
            first=0
        else
            echo ","
        fi
        echo "    {"
        echo "      \"ip\": \"$ip\","
        echo "      \"mac\": \"$mac\","
        echo "      \"rx_bytes\": 0,"
        echo "      \"tx_bytes\": 0"
        echo -n "    }"
    fi
done
echo "  ]"
echo "}"
