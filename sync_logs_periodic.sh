#!/bin/bash
# 日志转移定时任务（在本地机器运行）
# 从路由器拉取日志，转移到 NAS

ROUTER_IP="192.168.31.1"
ROUTER_USER="root"
ROUTER_PASSWORD="90c747a2"
NAS_IP="192.168.31.66"
NAS_USER="ctpdrqm"
NAS_PASSWORD="cx@4343506"

# SSH 连接选项
SSH_OPTS="-o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa"

# 日志文件
SYNC_LOG="/tmp/log_sync.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$SYNC_LOG"
}

# 1. 清理路由器上的旧日志
log "🧹 清理路由器上的旧日志..."
export SSHPASS="$ROUTER_PASSWORD"
sshpass -e ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" "sh /data/clean_logs.sh" >> "$SYNC_LOG" 2>&1

# 2. 从路由器获取日志文件列表并转移
log "📤 转移日志到 NAS..."
sshpass -e ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" \
    "ls -1 /data/ShellCrash/*.log /tmp/ShellCrash/*.log /userdisk/nas_clash/logs/*.log 2>/dev/null | head -10" | while read -r logfile; do

    if [ -n "$logfile" ]; then
        filename=$(basename "$logfile")
        tempfile="/tmp/$filename"

        # 从路由器通过 SSH cat 复制到本地临时位置
        if sshpass -p "$ROUTER_PASSWORD" ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" \
            "cat '$logfile'" > "$tempfile" 2>/dev/null; then

            # 从本地转移到 NAS
            if sshpass -p "$NAS_PASSWORD" scp -o StrictHostKeyChecking=no \
                "$tempfile" "$NAS_USER@$NAS_IP:/vol1/1000/clash-full-storage/logs/" 2>/dev/null; then
                log "✓ 已转移: $filename"
            else
                log "✗ 转移失败: $filename"
            fi

            # 删除本地临时文件
            rm -f "$tempfile"
        fi
    fi
done

# 3. 检查磁盘使用率
log "📊 检查磁盘状态..."
USAGE=$(sshpass -p "$ROUTER_PASSWORD" ssh $SSH_OPTS "$ROUTER_USER@$ROUTER_IP" \
    "df /data | tail -1 | awk '{print \$5}' | sed 's/%//'")

if [ -n "$USAGE" ]; then
    log "当前使用率: ${USAGE}%"
    if [ "$USAGE" -gt 92 ]; then
        log "⚠️ 警告: 使用率 > 92%"
    fi
fi

log "✅ 同步完成"
log ""
