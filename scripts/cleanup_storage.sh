#!/bin/sh
# 路由器存储空间自动清理脚本
# 功能：定期清理日志、缓存等无关文件，防止 /data 满载
# 部署：在路由器上运行，或从 NAS 容器定期触发

set -e

ROUTER_IP=${ROUTER_IP:-192.168.31.1}
ROUTER_USER=${ROUTER_USER:-root}
ROUTER_PASSWORD=${ROUTER_PASSWORD}

# 检查环境
if [ -z "$ROUTER_PASSWORD" ]; then
    echo "❌ 错误: 需要设置 ROUTER_PASSWORD 环境变量"
    exit 1
fi

# 通过 sshpass 连接路由器执行清理
echo "🧹 正在清理路由器存储空间..."

sshpass -p "$ROUTER_PASSWORD" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa "$ROUTER_USER@$ROUTER_IP" << 'CLEAN_SCRIPT'
#!/bin/sh

echo "=== 存储清理开始 ==="
echo ""

# 1. 清理旧日志
echo "1️⃣  清理旧日志..."
find /data -name "*.log" -type f -mtime +7 -exec rm -f {} \; 2>/dev/null
echo "   ✓ 已清理 7 天前的日志"

# 2. 清理缓存
echo "2️⃣  清理过期缓存..."
[ -d /data/ShellCrash ] && rm -f /data/ShellCrash/cache.db 2>/dev/null
echo "   ✓ 已清理缓存数据库"

# 3. 清理临时文件
echo "3️⃣  清理临时文件..."
rm -rf /tmp/*.tmp 2>/dev/null
rm -rf /data/tmp/* 2>/dev/null 2>/dev/null
echo "   ✓ 已清理临时文件"

# 4. 显示当前使用
echo ""
echo "=== 清理后存储使用情况 ==="
df -h /data | tail -1 | awk '{printf "总容量: %s | 已用: %s | 可用: %s | 占用率: %s\n", $2, $3, $4, $5}'

# 5. 警告阈值检查
USAGE=$(df /data | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$USAGE" -gt 80 ]; then
    echo ""
    echo "⚠️  警告: 存储使用率超过 80%"
    echo "建议检查大文件或删除无用数据库（Country.mmdb, GeoSite.dat）"
fi

echo ""
echo "✅ 清理完成"
CLEAN_SCRIPT

echo ""
echo "🎉 清理任务完成"
