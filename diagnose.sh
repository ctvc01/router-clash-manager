#!/bin/bash
# Clash Gateway 故障诊断脚本
# 用法: ./diagnose.sh  (需要先通过 .env 配置路由器信息)

set -e

# 加载环境变量
if [ ! -f .env ]; then
    echo "❌ 错误：未找到 .env 文件，请先复制 .env.example 并配置"
    exit 1
fi

source .env

ROUTER_IP=${ROUTER_IP:-192.168.31.1}
ROUTER_USER=${ROUTER_USER:-root}

echo "====== Clash Gateway 诊断报告 ======"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "路由器: ssh://$ROUTER_USER@$ROUTER_IP"
echo ""

# 生成 expect 脚本
EXPECT_SCRIPT=$(mktemp)
cat > "$EXPECT_SCRIPT" << 'EXPECT_EOF'
#!/usr/bin/env expect
set timeout 10
set router_ip [lindex $argv 0]
set router_user [lindex $argv 1]
set router_pass [lindex $argv 2]

spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$router_user@$router_ip"
expect {
    "password:" { send "$router_pass\r"; exp_continue }
    "Permission denied" { puts "❌ 认证失败"; exit 1 }
    "#" { }
}

# 1. 检查 CrashCore 进程
puts "\n=== 1. CrashCore 进程状态 ==="
send "ps aux | grep -i crash | grep -v grep\r"
expect "#"

# 2. 检查核心端口监听
puts "\n=== 2. 核心端口监听状态 ==="
send "netstat -nlt | grep -E '(7890|1053|9999)'\r"
expect "#"

# 3. 检查最近日志
puts "\n=== 3. ShellCrash 运行日志 (最近30行) ==="
send "tail -30 /data/ShellCrash/run.log 2>/dev/null || echo '日志文件不存在'\r"
expect "#"

# 4. 检查启动错误标记
puts "\n=== 4. 启动错误标记文件 ==="
send "ls -la /data/ShellCrash/.start_error 2>&1\r"
expect "#"

# 5. 检查配置文件
puts "\n=== 5. Clash 配置文件 (首50行) ==="
send "head -50 /data/ShellCrash/yamls/config.yaml 2>/dev/null || echo '配置文件不存在'\r"
expect "#"

# 6. 检查 DNS 状态
puts "\n=== 6. DNS 解析测试 ==="
send "nslookup google.com 127.0.0.1 2>&1 | head -10\r"
expect "#"

# 7. 检查代理连通性
puts "\n=== 7. 代理端口连通性 (测试到 Google DNS) ==="
send "curl -I -s -k --connect-timeout 5 -x http://127.0.0.1:7890 http://cp.cloudflare.com/generate_204 | head -3\r"
expect "#"

# 8. 查看最近的系统错误日志
puts "\n=== 8. 系统错误日志 ==="
send "dmesg | tail -20\r"
expect "#"

send "exit\r"
expect eof
EXPECT_EOF

echo "[收集中...请稍候]"
echo ""

chmod +x "$EXPECT_SCRIPT"
expect "$EXPECT_SCRIPT" "$ROUTER_IP" "$ROUTER_USER" "$ROUTER_PASSWORD" 2>/dev/null || {
    echo "❌ 无法连接路由器"
    rm -f "$EXPECT_SCRIPT"
    exit 1
}

rm -f "$EXPECT_SCRIPT"

echo ""
echo "====== 诊断完成 ======"
echo "💡 提示：查看上方输出，重点关注："
echo "  1. CrashCore 进程是否存在（PID）"
echo "  2. 端口 7890/1053 是否在监听"
echo "  3. run.log 中是否有 ERROR 或 panic 错误"
echo "  4. 是否存在 .start_error 文件（存在则说明启动失败）"
