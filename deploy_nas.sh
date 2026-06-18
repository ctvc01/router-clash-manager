#!/bin/bash
set -e

# ============================================================
# router-clash-manager NAS 自动部署脚本
# 使用方式：bash deploy.sh
# ============================================================

PROJECT_DIR="/vol1/1000/router-clash-manager"
CONTAINER_NAME="clash-meta"
NAS_IP="192.168.31.66"
SERVICE_PORT="3000"

echo "================================"
echo "🚀 开始部署 Clash Meta"
echo "================================"

# 1. 进入项目目录
echo "📂 进入项目目录: $PROJECT_DIR"
cd "$PROJECT_DIR" || exit 1

# 2. 拉取最新代码
echo "📥 拉取最新代码..."
git pull origin main

# 3. 检查 .env 文件
if [ ! -f .env ]; then
    echo "❌ 错误: 找不到 .env 文件"
    echo "📝 请先创建 .env 文件，参考 .env.example"
    exit 1
fi

# 4. 停止并删除旧容器
echo "🛑 停止旧容器..."
docker compose down || true

# 5. 重新构建并启动容器
echo "🔨 重新构建并启动容器..."
docker compose up --build --force-recreate -d

# 6. 等待容器启动
echo "⏳ 等待容器启动 (10s)..."
sleep 10

# 7. 验证服务健康状态
echo "🔍 验证服务健康状态..."
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "http://$NAS_IP:$SERVICE_PORT/health" || echo "000")

if [ "$HEALTH_CHECK" = "200" ]; then
    echo "✅ 服务已成功启动！"
    echo "📊 访问地址: http://$NAS_IP:$SERVICE_PORT"
    echo ""
    echo "📋 容器状态:"
    docker ps -f name=$CONTAINER_NAME --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "📝 查看日志: docker logs -f $CONTAINER_NAME"
else
    echo "❌ 服务健康检查失败 (HTTP $HEALTH_CHECK)"
    echo "📝 查看日志了解详情:"
    docker logs $CONTAINER_NAME | tail -50
    exit 1
fi

echo "================================"
echo "✨ 部署完成！"
echo "================================"
