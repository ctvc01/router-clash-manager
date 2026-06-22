#!/bin/sh
# ============================================================
# 路由器日志转移脚本 - 将日志实时转移到 NAS
# 用途：在路由器上定期运行，将本地日志转移到 NAS，释放 /data 空间
# 部署：添加到 crontab（例如每 15 分钟执行一次）
# ============================================================

set -e

# 配置参数
ROUTER_LOG_PATHS=("/data/ShellCrash" "/tmp/ShellCrash")
NAS_IP="192.168.31.66"
NAS_USER="ctpdrqm"
NAS_DEST="/vol1/1000/clash-full-storage/logs"
NAS_BACKUP_DEST="/vol1/1000/clash-full-storage/backups"

# SCP 连接选项
SCP_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=no"

# 日志文件
TRANSFER_LOG="/tmp/nas_transfer.log"

# ============================================================
# 函数定义
# ============================================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$TRANSFER_LOG"
}

error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 错误: $*" >> "$TRANSFER_LOG"
}

success() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $*" >> "$TRANSFER_LOG"
}

# 检查 NAS 连通性
check_nas_connectivity() {
    if ping -c 1 "$NAS_IP" >/dev/null 2>&1; then
        success "NAS 可到达"
        return 0
    else
        error "NAS 不可达，跳过转移"
        return 1
    fi
}

# 转移日志文件到 NAS
transfer_logs() {
    local source_dir="$1"
    local log_count=0

    if [ ! -d "$source_dir" ]; then
        return 0
    fi

    log "正在扫描 $source_dir 中的日志文件..."

    # 找出所有日志文件并转移（保留最近 2 个文件）
    find "$source_dir" -maxdepth 1 -name "*.log" -type f 2>/dev/null | sort -r | tail -n +3 | while read -r logfile; do
        if [ -f "$logfile" ]; then
            local filename=$(basename "$logfile")
            log "转移日志: $filename"

            # 使用 scp 转移文件
            if scp $SCP_OPTS "$logfile" "${NAS_USER}@${NAS_IP}:${NAS_DEST}/" >/dev/null 2>&1; then
                log "✓ 已转移: $filename"
                # 删除本地副本
                rm -f "$logfile" 2>/dev/null && log "✓ 已删除本地副本: $filename"
                log_count=$((log_count + 1))
            else
                error "转移失败: $filename"
            fi
        fi
    done

    if [ $log_count -gt 0 ]; then
        success "本次转移 $log_count 个日志文件"
    fi
}

# 备份配置文件到 NAS
backup_config() {
    local config_file="/data/ShellCrash/config.yaml"
    local timestamp=$(date +%s)

    if [ -f "$config_file" ]; then
        log "备份配置文件..."
        local backup_name="config.yaml.$timestamp.bak"

        if scp $SCP_OPTS "$config_file" "${NAS_USER}@${NAS_IP}:${NAS_BACKUP_DEST}/${backup_name}" >/dev/null 2>&1; then
            success "配置已备份: $backup_name"
        else
            error "备份配置失败"
        fi
    fi
}

# 清理本地过期日志
cleanup_old_logs() {
    log "清理本地过期日志..."

    # 删除 7 天前的日志
    find /data -name "*.log" -type f -mtime +7 -exec rm -f {} \; 2>/dev/null
    find /tmp -name "*.log" -type f -mtime +3 -exec rm -f {} \; 2>/dev/null

    success "本地过期日志已清理"
}

# 检查磁盘使用率
check_disk_usage() {
    local usage=$(df /data | tail -1 | awk '{print $5}' | sed 's/%//')

    if [ -z "$usage" ]; then
        error "无法获取磁盘使用率"
        return 1
    fi

    log "当前 /data 使用率: ${usage}%"

    if [ "$usage" -gt 90 ]; then
        error "⚠️ 磁盘使用率高于 90%！"
        # 激进清理
        log "执行激进清理..."
        find /data -name "*.log" -type f -exec rm -f {} \; 2>/dev/null
        find /tmp -name "*.log" -type f -exec rm -f {} \; 2>/dev/null
        rm -f /data/ShellCrash/GeoSite.dat 2>/dev/null
        rm -f /data/ShellCrash/Country.mmdb 2>/dev/null
        success "激进清理完成"
    fi

    return 0
}

# ============================================================
# 主程序
# ============================================================

main() {
    log "========== 日志转移流程开始 =========="

    # 1. 检查 NAS 连通性
    if ! check_nas_connectivity; then
        log "NAS 不可用，使用本地清理方案"
        cleanup_old_logs
        check_disk_usage
        log "========== 流程结束（NAS 不可用） =========="
        exit 0
    fi

    # 2. 转移日志文件
    for path in $ROUTER_LOG_PATHS; do
        transfer_logs "$path"
    done

    # 3. 备份配置（仅每小时执行一次）
    local hour=$(date +%M)
    if [ "$hour" = "00" ]; then
        backup_config
    fi

    # 4. 清理本地过期日志
    cleanup_old_logs

    # 5. 检查磁盘使用率
    check_disk_usage

    log "========== 流程完成 =========="
}

# 执行主程序
main "$@"
