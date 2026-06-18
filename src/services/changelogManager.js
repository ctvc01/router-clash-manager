const fs = require('fs');
const path = require('path');
const Logger = require('../utils/logger');

class ChangelogManager {
    static CHANGELOG_FILE = '/app/CHANGELOG.md';
    static MAX_ENTRIES = 1000;

    // 记录配置变更
    static logChange(changeType, details, result) {
        try {
            const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const resultStr = result ? '✅ 成功' : '❌ 失败';

            const entry = `\n## [${timestamp}] ${changeType} ${resultStr}
- **类型**: ${changeType}
- **详情**: ${typeof details === 'object' ? JSON.stringify(details) : details}
- **时间**: ${timestamp}

`;

            // 追加到文件
            fs.appendFileSync(this.CHANGELOG_FILE, entry, 'utf8');

            // 防止文件过大
            this._trimIfNeeded();

            Logger.debug('Changelog', `记录变更: ${changeType} ${resultStr}`);
        } catch (e) {
            Logger.debug('Changelog', '记录变更失败', e);
        }
    }

    // 记录规则更新
    static logRulesUpdate(gameMacs, aiMacs, success, error = null) {
        const details = {
            gameMacs: gameMacs.length,
            aiMacs: aiMacs.length,
            timestamp: new Date().toISOString()
        };
        if (error) {
            details.error = error.message || String(error);
        }

        this.logChange('规则更新', details, success);
    }

    // 记录设备加速变更
    static logDeviceChange(action, mac, type, success) {
        const details = {
            action, // add/remove/update
            mac,
            type, // game/ai
            timestamp: new Date().toISOString()
        };
        this.logChange(`设备变更 [${type}]`, details, success);
    }

    // 记录节点切换
    static logNodeSwitch(group, node, success, delay = null) {
        const details = {
            group,
            node,
            delay,
            timestamp: new Date().toISOString()
        };
        this.logChange('节点切换', details, success);
    }

    // 记录配置恢复
    static logConfigRestore(fromVersion, toVersion, success) {
        const details = {
            from: fromVersion,
            to: toVersion,
            timestamp: new Date().toISOString()
        };
        this.logChange('配置恢复', details, success);
    }

    // 获取最近的变更记录
    static getRecentChanges(limit = 50) {
        try {
            if (!fs.existsSync(this.CHANGELOG_FILE)) {
                return [];
            }

            const content = fs.readFileSync(this.CHANGELOG_FILE, 'utf8');
            const entries = content.split('## [')
                .filter(e => e.trim())
                .map(e => '## [' + e)
                .slice(-limit);

            return entries;
        } catch (e) {
            Logger.debug('Changelog', '读取变更日志失败', e);
            return [];
        }
    }

    // 导出变更摘要（用于API）
    static getSummary() {
        try {
            if (!fs.existsSync(this.CHANGELOG_FILE)) {
                return { total: 0, recent: [] };
            }

            const content = fs.readFileSync(this.CHANGELOG_FILE, 'utf8');
            const entries = content.split('\n## [').filter(e => e.trim());

            // 统计各类型变更
            const stats = {
                规则更新: 0,
                设备变更: 0,
                节点切换: 0,
                配置恢复: 0
            };

            entries.forEach(entry => {
                for (const key of Object.keys(stats)) {
                    if (entry.includes(key)) stats[key]++;
                }
            });

            return {
                total: entries.length,
                stats,
                lastEntry: entries[entries.length - 1]?.slice(0, 100) || 'N/A'
            };
        } catch (e) {
            Logger.debug('Changelog', '获取摘要失败', e);
            return { total: 0, recent: [] };
        }
    }

    // 清空日志
    static clear() {
        try {
            fs.writeFileSync(this.CHANGELOG_FILE, '# Changelog\n\n', 'utf8');
            Logger.info('Changelog', '变更日志已清空');
            return true;
        } catch (e) {
            Logger.error('Changelog', '清空日志失败', e);
            return false;
        }
    }

    // 防止文件过大
    static _trimIfNeeded() {
        try {
            const stat = fs.statSync(this.CHANGELOG_FILE);
            if (stat.size > 5 * 1024 * 1024) { // 5MB
                const content = fs.readFileSync(this.CHANGELOG_FILE, 'utf8');
                const entries = content.split('\n## [');
                // 保留最后500条
                const trimmed = '# Changelog\n\n## [' + entries.slice(-500).join('\n## [');
                fs.writeFileSync(this.CHANGELOG_FILE, trimmed, 'utf8');
                Logger.info('Changelog', '日志文件已截断');
            }
        } catch (e) {
            // 忽略
        }
    }
}

// 初始化日志文件
if (!fs.existsSync(ChangelogManager.CHANGELOG_FILE)) {
    fs.writeFileSync(ChangelogManager.CHANGELOG_FILE, '# Changelog\n\n', 'utf8');
}

module.exports = ChangelogManager;
