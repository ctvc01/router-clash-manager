#!/bin/sh
# NAS Clash Meta 容器重启和部署脚本
# 用法：在 NAS 上执行此脚本以应用最新的代码修复

set -e

echo "=========================================="
echo "🚀 Clash Meta 容器重启部署"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""

# 1. 检查 Git 状态
echo "📝 [1/6] 检查 Git 状态"
cd /Users/cheng/Projects/router-clash-manager
git status
echo ""

# 2. 获取最新代码
echo "📥 [2/6] 拉取最新代码"
git pull origin main 2>/dev/null || echo "已是最新（本地提交）"
echo ""

# 3. 检查 Docker 状态
echo "🐳 [3/6] 检查 Docker 状态"
docker ps -a | grep clash-meta || echo "容器未找到"
echo ""

# 4. 构建新镜像（--no-cache 完整构建）
echo "🔨 [4/6] 构建新镜像"
echo "执行: docker-compose build --no-cache"
docker-compose build --no-cache
echo "✅ 镜像构建完成"
echo ""

# 5. 停止旧容器
echo "⏹️  [5/6] 停止并移除旧容器"
docker-compose down 2>/dev/null || echo "容器已停止"
sleep 2
echo "✅ 旧容器已移除"
echo ""

# 6. 启动新容器
echo "🚀 [6/6] 启动新容器"
docker-compose up -d
echo "✅ 新容器已启动"
sleep 3
echo ""

# 7. 验证状态
echo "📊 验证容器状态"
echo "---"
docker ps | grep clash-meta || echo "❌ 容器启动失败"
echo ""

# 8. 查看日志
echo "📋 查看启动日志（最后 20 行）"
echo "---"
docker logs -n 20 clash-meta 2>&1 || echo "日志查询失败"
echo ""

echo "=========================================="
echo "✅ 部署完成"
echo "=========================================="
echo ""
echo "🔍 后续检查:"
echo "  1. 观察日志是否有错误"
echo "  2. 测试 SSH 连接到路由器"
echo "  3. 验证 Clash 配置注入是否正常"
echo "  4. 测试设备网络连接"
echo ""
echo "📝 关键文件修改:"
echo "  - src/services/rulesEngine.js (TUN 块处理逻辑)"
echo "  - tests/unit/rulesEngine.test.js (测试案例)"
echo ""
