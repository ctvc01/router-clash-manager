#!/bin/sh
# 🛰️ 智能硬件与代理系统 - 安全防火墙引流脚本 (方案B)
# 采用自定义链隔离，直连设备不受任何影响，防止全局 PREROUTING 冲刷导致网络假死。

mkdir -p /var/run

# 1. 确保自定义链 CLASH_PRE 存在于 nat 表中
iptables -t nat -N CLASH_PRE 2>/dev/null

# 2. 清空自定义链 CLASH_PRE 的旧规则 (安全隔离，不影响 PREROUTING 中其他系统规则)
iptables -t nat -F CLASH_PRE 2>/dev/null

# 3. 检查并确保 PREROUTING 链的第一条规则是跳转到 CLASH_PRE
# 用 -C 检查规则是否存在，若不存在则 -I 插入到最前面，防重复注入
iptables -t nat -C PREROUTING -j CLASH_PRE 2>/dev/null || iptables -t nat -I PREROUTING -j CLASH_PRE

# 4. 读取白名单设备 MAC 地址，注入流量劫持规则
if [ -f /data/ShellCrash/configs/mac ]; then
  while read mac; do
    # 剔除空行和注释行
    [ -z "$mac" ] && continue
    echo "$mac" | grep -q '^#' && continue
    
    # 统一转换为大写以匹配 iptables (防大小写不一致失效)
    mac=$(echo "$mac" | tr 'a-z' 'A-Z')
    
    # 仅劫持白名单设备的 UDP 53 端口 (DNS) 重定向到 Clash DNS 1053 端口
    iptables -t nat -A CLASH_PRE -m mac --mac-source "$mac" -p udp --dport 53 -j REDIRECT --to-ports 1053
    # 仅劫持白名单设备的 TCP 流量重定向到 Clash 透明代理 7892 端口
    iptables -t nat -A CLASH_PRE -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports 7892
  done < /data/ShellCrash/configs/mac
fi

echo "iptables: \$(iptables -t nat -L CLASH_PRE -n | grep -c REDIRECT) rules applied safely in CLASH_PRE chain."
