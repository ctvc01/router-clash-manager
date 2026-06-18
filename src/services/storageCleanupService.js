const SshService = require('./sshService');
const Logger = require('../utils/logger');

let storageCleanupTimer = null;

class StorageCleanupService {
    // 启动定时清理任务（每天凌晨 02:00 执行一次）
    static startDailyCleanup() {
        if (storageCleanupTimer) return;

        Logger.info('StorageCleanup', '🧹 启动存储空间定期清理任务（每日凌晨 02:00）...');

        // 计算距离下次凌晨 2:00 的延迟
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(2, 0, 0, 0);
        const delayMs = tomorrow - now;

        // 首次执行
        setTimeout(async () => {
            await this.cleanupStorage();
            // 之后每 24 小时执行一次
            storageCleanupTimer = setInterval(async () => {
                await this.cleanupStorage();
            }, 24 * 60 * 60 * 1000);
        }, delayMs);

        Logger.info('StorageCleanup', `下次清理将在 ${tomorrow.toLocaleString('zh-CN')} 执行`);
    }

    // 清理路由器存储空间
    static async cleanupStorage() {
        try {
            Logger.info('StorageCleanup', '🧹 开始清理路由器存储空间...');

            // 1. 清理旧日志（7 天前）
            await SshService.runRemoteCommand("find /data -name '*.log' -type f -mtime +7 -exec rm -f {} \\; 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理 7 天前的日志');

            // 2. 清理缓存数据库
            await SshService.runRemoteCommand("rm -f /data/ShellCrash/cache.db 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理缓存数据库');

            // 3. 清理临时文件
            await SshService.runRemoteCommand("rm -rf /tmp/*.tmp /data/tmp/* 2>/dev/null");
            Logger.info('StorageCleanup', '✓ 已清理临时文件');

            // 4. 检查存储使用率
            const output = await SshService.runRemoteCommand("df /data | tail -1 | awk '{print $5}' | sed 's/%//'");
            const usage = parseInt(output.trim());

            if (!isNaN(usage)) {
                Logger.info('StorageCleanup', `📊 当前 /data 使用率: ${usage}%`);

                // 5. 如果使用率超过 80%，发出警告
                if (usage > 80) {
                    Logger.warn('StorageCleanup', `⚠️ 警告: 存储使用率高于 80%，建议删除无用文件`);
                    Logger.warn('StorageCleanup', `   可选删除：Country.mmdb (8M) 和 GeoSite.dat (4M)`);
                }
            }

            Logger.info('StorageCleanup', '✅ 清理任务完成');
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
