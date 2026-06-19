const SshService = require('./sshService');
const Logger = require('../utils/logger');

let storageCleanupTimer = null;
let lastCleanupTime = 0;

class StorageCleanupService {
    // 启动定时清理任务 + 实时监控
    static startDailyCleanup() {
        if (storageCleanupTimer) return;

        Logger.info('StorageCleanup', '🧹 启动存储空间监控系统（定时 + 实时）...');

        // 计算距离下次凌晨 2:00 的延迟
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(2, 0, 0, 0);
        const delayMs = tomorrow - now;

        // 首次执行定时清理
        setTimeout(async () => {
            await this.cleanupStorage();
            // 之后每 24 小时执行一次定时清理
            storageCleanupTimer = setInterval(async () => {
                await this.cleanupStorage();
            }, 24 * 60 * 60 * 1000);
        }, delayMs);

        Logger.info('StorageCleanup', `下次定时清理将在 ${tomorrow.toLocaleString('zh-CN')} 执行`);
    }

    // 获取当前磁盘使用率（包含出错处理）
    static async getDiskUsage() {
        try {
            const output = await SshService.runRemoteCommand("df /data | tail -1 | awk '{print $5}' | sed 's/%//'");
            const usage = parseInt(output.trim());
            return isNaN(usage) ? null : usage;
        } catch (err) {
            Logger.warn('StorageCleanup', '获取磁盘使用率失败', err);
            return null;
        }
    }

    // 实时检查 - 在关键 API 调用前检查并清理（防止出错）
    static async checkAndCleanupIfNeeded() {
        const now = Date.now();
        // 防止频繁清理，最多 5 分钟执行一次
        if (now - lastCleanupTime < 5 * 60 * 1000) {
            return;
        }

        try {
            const usage = await this.getDiskUsage();
            if (usage === null) return;

            // 根据使用率触发不同级别的清理
            if (usage >= 95) {
                Logger.warn('StorageCleanup', `🚨 临界：磁盘使用率 ${usage}%，执行紧急清理（Level 3）`);
                await this.emergencyCleanup();
                lastCleanupTime = now;
            } else if (usage >= 90) {
                Logger.warn('StorageCleanup', `⚠️ 高：磁盘使用率 ${usage}%，执行主动清理（Level 2）`);
                await this.aggressiveCleanup();
                lastCleanupTime = now;
            } else if (usage >= 85) {
                Logger.warn('StorageCleanup', `⚡ 注意：磁盘使用率 ${usage}%，执行基础清理（Level 1）`);
                await this.basicCleanup();
                lastCleanupTime = now;
            }
        } catch (err) {
            Logger.warn('StorageCleanup', '实时检查执行失败', err);
        }
    }

    // 基础清理（Level 1: 85%+）
    static async basicCleanup() {
        try {
            Logger.debug('StorageCleanup', 'Level 1: 清理 > 1 天的日志');
            await SshService.runRemoteCommand("find /data -name '*.log' -type f -mtime +1 -exec rm -f {} \\; 2>/dev/null");
            await SshService.runRemoteCommand("rm -f /data/ShellCrash/cache.db 2>/dev/null");
        } catch (err) {
            Logger.warn('StorageCleanup', 'Level 1 清理失败', err);
        }
    }

    // 主动清理（Level 2: 90%+）
    static async aggressiveCleanup() {
        try {
            Logger.debug('StorageCleanup', 'Level 2: 删除可选文件 (GeoSite.dat)');
            await this.basicCleanup();
            await SshService.runRemoteCommand("rm -f /data/ShellCrash/GeoSite.dat 2>/dev/null");
        } catch (err) {
            Logger.warn('StorageCleanup', 'Level 2 清理失败', err);
        }
    }

    // 紧急清理（Level 3: 95%+）
    static async emergencyCleanup() {
        try {
            Logger.debug('StorageCleanup', 'Level 3: 删除所有可选文件 + 所有日志');
            await this.aggressiveCleanup();
            await SshService.runRemoteCommand("find /data -name '*.log' -type f -exec rm -f {} \\; 2>/dev/null");
            await SshService.runRemoteCommand("rm -f /data/ShellCrash/Country.mmdb 2>/dev/null");
        } catch (err) {
            Logger.warn('StorageCleanup', 'Level 3 清理失败', err);
        }
    }

    // 完整清理流程（定时任务调用）
    static async cleanupStorage() {
        try {
            Logger.info('StorageCleanup', '🧹 执行定时清理流程...');

            // 1. 清理旧日志（3 天前）
            await SshService.runRemoteCommand("find /data -name '*.log' -type f -mtime +3 -exec rm -f {} \\; 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理 3 天前的日志');

            // 2. 清理缓存数据库
            await SshService.runRemoteCommand("rm -f /data/ShellCrash/cache.db 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理缓存数据库');

            // 3. 清理临时文件
            await SshService.runRemoteCommand("rm -rf /tmp/*.tmp /data/tmp/* 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理临时文件');

            // 4. 检查存储使用率
            const usage = await this.getDiskUsage();
            if (usage !== null) {
                Logger.info('StorageCleanup', `📊 当前 /data 使用率: ${usage}%`);

                // 5. 根据使用率给出建议
                if (usage >= 90) {
                    Logger.warn('StorageCleanup', `⚠️ 高于 90%：建议删除 GeoSite.dat 和 Country.mmdb`);
                } else if (usage >= 85) {
                    Logger.warn('StorageCleanup', `⚠️ 高于 85%：建议减少日志保留天数`);
                }
            }

            Logger.info('StorageCleanup', '✅ 定时清理任务完成');
        } catch (err) {
            Logger.error('StorageCleanup', '清理任务执行失败', err);
        }
    }

    // 停止清理任务
    static stopDailyCleanup() {
        if (storageCleanupTimer) {
            clearInterval(storageCleanupTimer);
            storageCleanupTimer = null;
            Logger.info('StorageCleanup', '⏹️ 存储清理任务已停止');
        }
    }

    // 手动触发一次清理（用于诊断或紧急清理）
    static async cleanupNow() {
        Logger.info('StorageCleanup', '🧹 手动触发存储清理...');
        return await this.cleanupStorage();
    }
}

module.exports = StorageCleanupService;
