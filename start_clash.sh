#!/bin/bash
# 启动 Clash Meta 脚本
# 用法：sh /data/ShellCrash/start_clash.sh

set -e

CRASHDIR="/data/ShellCrash"
CLASH_BIN="$CRASHDIR/Clash"
CONFIG="$CRASHDIR/yamls/config.yaml"

# 检查二进制文件
if [ ! -x "$CLASH_BIN" ]; then
    echo "❌ 错误: Clash 二进制文件不存在或无执行权限"
    echo "路径: $CLASH_BIN"
    exit 1
fi

# 检查配置文件
if [ ! -f "$CONFIG" ]; then
    echo "❌ 错误: 配置文件不存在: $CONFIG"
    exit 1
fi

# 清除启动锁定
rm -f "$CRASHDIR/.start_error" 2>/dev/null

# 停止旧进程
if pidof Clash >/dev/null 2>&1; then
    echo "🛑 停止旧 Clash 进程..."
    kill $(pidof Clash) 2>/dev/null || true
    sleep 2
fi

# 启动新进程
echo "🚀 启动 Clash Meta..."
$CLASH_BIN -d "$CRASHDIR" -f "$CONFIG" </dev/null >/dev/null 2>&1 &

# 等待启动
sleep 3

# 验证
if pidof Clash >/dev/null 2>&1; then
    echo "✅ Clash Meta 已启动 (PID: $(pidof Clash))"
    echo "🌐 代理端口: 127.0.0.1:7890"
    echo "🔌 API 端口: 127.0.0.1:9999"
    echo "📡 DNS 端口: 127.0.0.1:1053"
    exit 0
else
    echo "❌ Clash 启动失败"
    exit 1
fi
