#!/bin/bash
# ============================================================
# NAS 日志分流 - 从本地控制面板执行
# 功能：从本地定期拉取路由器日志，转移到 NAS
# ============================================================

set -e

# 配置
ROUTER_IP="192.168.31.1"
ROUTER_USER="root"
ROUTER_PASSWORD="${ROUTER_PASSWORD}"
NAS_IP="192.168.31.66"
NAS_USER="ctpdrqm"
NAS_PASSWORD="${NAS_PASSWORD}"

# 验证参数
if [ -z "$ROUTER_PASSWORD" ]; then
    echo "❌ 错误: 需要 export ROUTER_PASSWORD=\"90c747a2\""
    exit 1
fi

if [ -z "$NAS_PASSWORD" ]; then
    echo "❌ 错误: 需要 export NAS_PASSWORD=\"cx@4343506\""
    exit 1
fi

# 日志文件
TRANSFER_LOG="/tmp/router_log_sync_$(date +%Y%m%d).log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$TRANSFER_LOG"
}

success() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $*" | tee -a "$TRANSFER_LOG"
}

error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 错误: $*" | tee -a "$TRANSFER_LOG"
}

# ============================================================
# 第 1 步：在 NAS 上创建目录
# ============================================================

setup_nas_directories() {
    log "════════════════════════════════════════════"
    log "🚀 第 1 步: 在 NAS 上创建目录结构"
    log "════════════════════════════════════════════"

    export SSHPASS="$NAS_PASSWORD"

    sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ctpdrqm@"$NAS_IP" << 'NAS_SETUP'
mkdir -p /vol1/1000/clash-full-storage/{logs,backups,data}
chmod 777 /vol1/1000/clash-full-storage/*
ls -la /vol1/1000/clash-full-storage/
NAS_SETUP

    success "NAS 目录已准备"
}

# ============================================================
# 第 2 步：在路由器上部署转移脚本
# ============================================================

deploy_router_script() {
    log "════════════════════════════════════════════"
    log "📝 第 2 步: 在路由器上部署转移脚本"
    log "════════════════════════════════════════════"

    export SSHPASS="$ROUTER_PASSWORD"

    # 在路由器上创建脚本
    sshpass -e ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
        root@"$ROUTER_IP" << 'ROUTER_SCRIPT'
#!/bin/sh
# 日志清理脚本（在路由器上运行）

# 保留最近 2 个日志，删除其他旧日志
find /data/ShellCrash -maxdepth 1 -name "*.log" -type f -print0 2>/dev/null | sort -z -r | tail -zn +3 | xargs -0 rm -f 2>/dev/null
find /tmp/ShellCrash -maxdepth 1 -name "*.log" -type f -print0 2>/dev/null | sort -z -r | tail -zn +3 | xargs -0 rm -f 2>/dev/null

# 清理 7 天前的日志
find /data -name "*.log" -type f -mtime +7 -exec rm -f {} \; 2>/dev/null
find /tmp -name "*.log" -type f -mtime +3 -exec rm -f {} \; 2>/dev/null

# 如果使用率 > 90%，执行激进清理
USAGE=$(df /data | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$USAGE" -gt 90 ]; then
    rm -f /data/ShellCrash/geoip.metadb 2>/dev/null
    rm -f /data/ShellCrash/Country.mmdb 2>/dev/null
    rm -f /data/ShellCrash/GeoSite.dat 2>/dev/null
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') 清理完成，使用率: ${USAGE}%"
ROUTER_SCRIPT

    success "转移脚本已部署"
}

# ============================================================
# 第 3 步：从本地定期同步日志
# ============================================================

sync_logs_to_nas() {
    log "════════════════════════════════════════════"
    log "🔄 第 3 步: 同步日志文件到 NAS"
    log "════════════════════════════════════════════"

    export SSHPASS_ROUTER="$ROUTER_PASSWORD"
    export SSHPASS_NAS="$NAS_PASSWORD"

    # 获取路由器上的日志文件列表
    log "正在扫描路由器上的日志文件..."

    # 检查 /data/ShellCrash 中的日志
    sshpass -p "$SSHPASS_ROUTER" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
        root@"$ROUTER_IP" "find /data/ShellCrash -maxdepth 1 -name '*.log' -type f 2>/dev/null" | while read -r logfile; do

        if [ -n "$logfile" ]; then
            local filename=$(basename "$logfile")
            log "转移 /data/ShellCrash/$filename..."

            # 从路由器复制到本地临时位置
            sshpass -p "$SSHPASS_ROUTER" scp -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
                "root@$ROUTER_IP:$logfile" "/tmp/$filename" 2>/dev/null

            if [ -f "/tmp/$filename" ]; then
                # 从本地转移到 NAS
                sshpass -p "$SSHPASS_NAS" scp -o StrictHostKeyChecking=no \
                    "/tmp/$filename" "ctpdrqm@$NAS_IP:/vol1/1000/clash-full-storage/logs/" 2>/dev/null && \
                    log "✓ 已转移: $filename" || \
                    error "转移失败: $filename"

                # 删除本地临时文件
                rm -f "/tmp/$filename"

                # 删除路由器上的文件（保留最近 2 个）
                # 实际上由上面的清理脚本在路由器上处理
            fi
        fi
    done

    # 检查 /tmp/ShellCrash 中的日志
    sshpass -p "$SSHPASS_ROUTER" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
        root@"$ROUTER_IP" "find /tmp/ShellCrash -maxdepth 1 -name '*.log' -type f 2>/dev/null | head -5" | while read -r logfile; do

        if [ -n "$logfile" ]; then
            local filename=$(basename "$logfile")
            log "转移 /tmp/ShellCrash/$filename..."

            # 从路由器复制到本地临时位置
            sshpass -p "$SSHPASS_ROUTER" scp -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
                "root@$ROUTER_IP:$logfile" "/tmp/$filename" 2>/dev/null

            if [ -f "/tmp/$filename" ]; then
                # 从本地转移到 NAS
                sshpass -p "$SSHPASS_NAS" scp -o StrictHostKeyChecking=no \
                    "/tmp/$filename" "ctpdrqm@$NAS_IP:/vol1/1000/clash-full-storage/logs/" 2>/dev/null && \
                    log "✓ 已转移: $filename" || \
                    error "转移失败: $filename"

                # 删除本地临时文件
                rm -f "/tmp/$filename"
            fi
        fi
    done

    success "日志同步完成"
}

# ============================================================
# 第 4 步：备份配置
# ============================================================

backup_config() {
    log "════════════════════════════════════════════"
    log "💾 第 4 步: 备份 Clash 配置"
    log "════════════════════════════════════════════"

    export SSHPASS_ROUTER="$ROUTER_PASSWORD"
    export SSHPASS_NAS="$NAS_PASSWORD"

    local timestamp=$(date +%s)
    local config_backup="/tmp/config.yaml.$timestamp.bak"

    # 从路由器复制配置
    if sshpass -p "$SSHPASS_ROUTER" scp -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
        "root@$ROUTER_IP:/data/ShellCrash/config.yaml" "$config_backup" 2>/dev/null; then

        # 转移到 NAS
        if sshpass -p "$SSHPASS_NAS" scp -o StrictHostKeyChecking=no \
            "$config_backup" "ctpdrqm@$NAS_IP:/vol1/1000/clash-full-storage/backups/" 2>/dev/null; then
            success "配置已备份到 NAS"
        else
            error "备份到 NAS 失败"
        fi

        # 清理本地临时文件
        rm -f "$config_backup"
    else
        log "未找到配置文件或备份失败"
    fi
}

# ============================================================
# 第 5 步：检查磁盘使用率
# ============================================================

check_disk_usage() {
    log "════════════════════════════════════════════"
    log "📊 第 5 步: 检查磁盘状态"
    log "════════════════════════════════════════════"

    export SSHPASS="$ROUTER_PASSWORD"

    local usage=$(sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
        root@"$ROUTER_IP" "df /data | tail -1 | awk '{print \$5}' | sed 's/%//'")

    if [ -n "$usage" ]; then
        log "当前 /data 使用率: ${usage}%"

        if [ "$usage" -gt 90 ]; then
            error "⚠️ 使用率高于 90%！即将执行激进清理"
            sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa \
                root@"$ROUTER_IP" "rm -f /data/ShellCrash/geoip.metadb /data/ShellCrash/Country.mmdb" 2>/dev/null
        fi
    fi
}

# ============================================================
# 主程序
# ============================================================

main() {
    log ""
    log "╔════════════════════════════════════════════╗"
    log "║  🚀 开始 NAS 日志分流完整部署              ║"
    log "╚════════════════════════════════════════════╝"
    log ""

    setup_nas_directories
    deploy_router_script
    sync_logs_to_nas
    backup_config
    check_disk_usage

    log ""
    log "╔════════════════════════════════════════════╗"
    log "║  ✨ 部署完成！                            ║"
    log "╚════════════════════════════════════════════╝"
    log ""
    log "📋 后续操作："
    log "  1. 在 crontab 中定期运行此脚本："
    log "     */15 * * * * cd /Users/cheng/Projects/router-clash-manager && bash deploy_nas_log_distribution_v2.sh 2>&1"
    log ""
    log "  2. 查看同步日志："
    log "     tail -f $TRANSFER_LOG"
    log ""
    log "  3. 查看 NAS 上的日志："
    log "     ssh ctpdrqm@192.168.31.66 'ls -lh /vol1/1000/clash-full-storage/logs/'"
    log ""
}

main "$@"
