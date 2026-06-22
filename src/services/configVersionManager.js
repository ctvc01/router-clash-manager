const fs = require('fs');
const path = require('path');
const Logger = require('../utils/logger');
const { config } = require('../config');

class ConfigVersionManager {
    static VERSION_DIR = config.paths.configVersions;
    static MAX_VERSIONS = 10;
    static BACKUP_INTERVAL = 5 * 60 * 1000; // 5分钟检测一次

    static backupTimer = null;

    // 初始化版本目录
    static initialize() {
        try {
            if (!fs.existsSync(this.VERSION_DIR)) {
                fs.mkdirSync(this.VERSION_DIR, { recursive: true });
                Logger.info('ConfigVersion', '✅ 配置版本管理目录已创建');
            }
        } catch (e) {
            Logger.error('ConfigVersion', '初始化版本目录失败', e);
        }
    }

    // 创建配置快照（带时间戳）
    static createSnapshot(configPath, tag = '') {
        try {
            if (!fs.existsSync(configPath)) {
                Logger.debug('ConfigVersion', `配置文件不存在: ${configPath}`);
                return null;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const filename = `config_${timestamp}${tag}.yaml`;
            const snapshotPath = path.join(this.VERSION_DIR, filename);

            const content = fs.readFileSync(configPath, 'utf8');
            fs.writeFileSync(snapshotPath, content, 'utf8');

            Logger.info('ConfigVersion', `📸 配置快照已保存: ${filename} (${(content.length / 1024).toFixed(2)}KB)`);

            // 自动清理超过限制的旧版本
            this._cleanupOldVersions();

            return snapshotPath;
        } catch (e) {
            Logger.error('ConfigVersion', '创建配置快照失败', e);
            return null;
        }
    }

    // 列出所有可用版本
    static listVersions() {
        try {
            if (!fs.existsSync(this.VERSION_DIR)) {
                return [];
            }

            return fs.readdirSync(this.VERSION_DIR)
                .filter(f => f.startsWith('config_'))
                .sort()
                .reverse()
                .map((filename, index) => {
                    const filepath = path.join(this.VERSION_DIR, filename);
                    const stat = fs.statSync(filepath);
                    return {
                        index,
                        filename,
                        size: stat.size,
                        time: stat.mtime,
                        path: filepath
                    };
                });
        } catch (e) {
            Logger.error('ConfigVersion', '列出版本失败', e);
            return [];
        }
    }

    // 恢复到指定版本
    static restoreVersion(versionIndex, targetPath) {
        try {
            const versions = this.listVersions();
            if (versionIndex < 0 || versionIndex >= versions.length) {
                throw new Error(`版本索引越界: ${versionIndex}`);
            }

            const version = versions[versionIndex];
            const content = fs.readFileSync(version.path, 'utf8');

            // 备份当前配置
            if (fs.existsSync(targetPath)) {
                const backupTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const backupFile = path.join(this.VERSION_DIR, `config_before_restore_${backupTag}.yaml`);
                fs.copyFileSync(targetPath, backupFile);
                Logger.info('ConfigVersion', `📦 当前配置已备份到恢复快照`);
            }

            // 恢复
            fs.writeFileSync(targetPath, content, 'utf8');
            Logger.info('ConfigVersion', `✅ 已恢复到版本: ${version.filename}`);

            return true;
        } catch (e) {
            Logger.error('ConfigVersion', '恢复配置失败', e);
            return false;
        }
    }

    // 删除指定版本
    static deleteVersion(versionIndex) {
        try {
            const versions = this.listVersions();
            if (versionIndex < 0 || versionIndex >= versions.length) {
                throw new Error(`版本索引越界: ${versionIndex}`);
            }

            const version = versions[versionIndex];
            fs.unlinkSync(version.path);
            Logger.info('ConfigVersion', `🗑️ 已删除版本: ${version.filename}`);
            return true;
        } catch (e) {
            Logger.error('ConfigVersion', '删除版本失败', e);
            return false;
        }
    }

    // 清理超出限制的旧版本
    static _cleanupOldVersions() {
        try {
            const versions = this.listVersions();
            if (versions.length > this.MAX_VERSIONS) {
                const toDelete = versions.slice(this.MAX_VERSIONS);
                toDelete.forEach(v => {
                    try {
                        fs.unlinkSync(v.path);
                        Logger.debug('ConfigVersion', `清理过期版本: ${v.filename}`);
                    } catch (e) {
                        // 忽略删除失败
                    }
                });
            }
        } catch (e) {
            Logger.debug('ConfigVersion', '清理版本时出错', e);
        }
    }

    // 启动自动备份任务
    static startAutoBackup(configPath) {
        if (this.backupTimer) return;

        Logger.info('ConfigVersion', '🔄 启动自动配置备份任务');
        this.backupTimer = setInterval(() => {
            try {
                if (fs.existsSync(configPath)) {
                    const stat = fs.statSync(configPath);
                    // 只在文件有更新时才备份
                    if (stat.size > 0) {
                        this.createSnapshot(configPath);
                    }
                }
            } catch (e) {
                Logger.debug('ConfigVersion', '自动备份失败', e);
            }
        }, this.BACKUP_INTERVAL);
    }

    // 停止自动备份
    static stopAutoBackup() {
        if (this.backupTimer) {
            clearInterval(this.backupTimer);
            this.backupTimer = null;
            Logger.info('ConfigVersion', '自动配置备份已停止');
        }
    }
}

module.exports = ConfigVersionManager;
