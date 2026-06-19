#!/bin/bash
# ============================================================
# NAS 日志分流完整部署脚本
# 功能：
#   1. 在 NAS 上创建必要的目录
#   2. 将日志转移脚本部署到路由器
#   3. 配置路由器的 crontab 定时任务
# ============================================================

set -e

# 配置
ROUTER_IP="${ROUTER_IP:-192.168.31.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASSWORD="${ROUTER_PASSWORD}"
NAS_IP="${NAS_IP:-192.168.31.66}"
NAS_USER="${NAS_USER:-ctpdrqm}"
NAS_PASSWORD="${NAS_PASSWORD}"

# 验证参数
check_params() {
    if [ -z "$ROUTER_PASSWORD" ]; then
        echo "❌ 错误: 需要设置 ROUTER_PASSWORD 环境变量"
        exit 1
    fi

    if [ -z "$NAS_PASSWORD" ]; then
        echo "❌ 错误: 需要设置 NAS_PASSWORD 环境变量"
        exit 1
    fi
}

# 第 1 步：在 NAS 上创建目录
setup_nas_directories() {
    echo "📁 第 1 步: 在 NAS 上创建目录结构..."

    sshpass -p "$NAS_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ctpdrqm@"$NAS_IP" << 'NAS_SETUP'
set -e

echo "创建 Clash 存储目录..."
mkdir -p /vol1/1000/clash-full-storage/{logs,backups,data,cache}

echo "设置权限..."
chmod 777 /vol1/1000/clash-full-storage/*

echo "验证目录结构..."
ls -la /vol1/1000/clash-full-storage/

echo "✅ NAS 目录已准备"
NAS_SETUP

    echo "✅ NAS 目录创建完成"
}

# 第 2 步：在路由器上部署日志转移脚本
deploy_transfer_script() {
    echo "📝 第 2 步: 将日志转移脚本部署到路由器..."

    # 创建临时文件
    local temp_script="/tmp/router_log_transfer_$$.sh"

    # 复制脚本到临时位置
    cp "$(dirname "$0")/router_log_transfer.sh" "$temp_script"

    # 通过 sshpass 部署
    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa root@"$ROUTER_IP" << 'ROUTER_DEPLOY'
set -e

echo "在路由器上创建脚本目录..."
mkdir -p /data/scripts

echo "✅ 脚本目录已创建"
ROUTER_DEPLOY

    # 通过 scp 转移脚本文件
    sshpass -p "$ROUTER_PASSWORD" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa "$temp_script" root@"$ROUTER_IP":/data/scripts/log_transfer.sh

    # 在路由器上设置权限
    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa root@"$ROUTER_IP" \
        "chmod +x /data/scripts/log_transfer.sh && echo '✅ 脚本部署完成'"

    # 清理临时文件
    rm -f "$temp_script"

    echo "✅ 日志转移脚本已部署"
}

# 第 3 步：配置路由器 crontab
setup_crontab() {
    echo "⏰ 第 3 步: 配置路由器定时任务..."

    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa root@"$ROUTER_IP" << 'CRON_SETUP'
set -e

# 清理旧的 crontab 条目（避免重复）
crontab -l 2>/dev/null | grep -v "log_transfer.sh" | crontab - 2>/dev/null || true

# 添加新的 crontab 条目
# 每 15 分钟执行一次日志转移
(crontab -l 2>/dev/null || echo ""; echo "*/15 * * * * /data/scripts/log_transfer.sh") | crontab -

echo "✅ Crontab 已配置（每 15 分钟执行）"
echo ""
echo "当前 crontab 任务："
crontab -l | grep log_transfer || true
CRON_SETUP

    echo "✅ 定时任务配置完成"
}

# 第 4 步：手动执行一次（验证）
test_transfer() {
    echo "🧪 第 4 步: 手动执行测试转移..."

    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa root@"$ROUTER_IP" \
        "/data/scripts/log_transfer.sh 2>&1 | tail -20"

    echo "✅ 测试转移完成"
}

# 第 5 步：验证结果
verify_setup() {
    echo "✅ 第 5 步: 验证部署结果..."

    echo ""
    echo "检查路由器上的脚本..."
    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa root@"$ROUTER_IP" \
        "ls -lh /data/scripts/log_transfer.sh && echo '✓ 脚本已部署'"

    echo ""
    echo "检查 NAS 上的日志目录..."
    sshpass -p "$NAS_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        ctpdrqm@"$NAS_IP" \
        "du -sh /vol1/1000/clash-full-storage/{logs,backups} 2>/dev/null || echo '✓ 目录已创建'"

    echo ""
    echo "检查最近的转移日志..."
    sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o PubkeyAcceptedAlgorithms=+ssh-rsa root@"$ROUTER_IP" \
        "tail -10 /tmp/nas_transfer.log || echo '还未执行转移'"

    echo ""
    echo "✅ 验证完成"
}

# ============================================================
# 主程序
# ============================================================

main() {
    echo "================================"
    echo "🚀 NAS 日志分流完整部署"
    echo "================================"
    echo ""

    check_params
    setup_nas_directories
    echo ""
    deploy_transfer_script
    echo ""
    setup_crontab
    echo ""
    test_transfer
    echo ""
    verify_setup

    echo ""
    echo "================================"
    echo "✨ 部署完成！"
    echo "================================"
    echo ""
    echo "📊 后续检查："
    echo "  1. 查看转移日志: ssh root@192.168.31.1 'tail -f /tmp/nas_transfer.log'"
    echo "  2. 检查 NAS 日志: ssh ctpdrqm@192.168.31.66 'ls -la /vol1/1000/clash-full-storage/logs/'"
    echo "  3. 检查磁盘使用: ssh root@192.168.31.1 'df -h /data'"
}

main "$@"
