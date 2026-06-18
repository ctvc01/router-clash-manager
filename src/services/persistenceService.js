const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const Logger = require('../utils/logger');

class PersistenceService {
    // 初始化模板
    static TEMPLATES = {
        device_custom: {},
        aliases: {},
        game_devices: '',
        ai_devices: ''
    };

    // 所有需要持久化的文件
    static FILES = {
        device_custom: config.paths.custom,
        aliases: path.join(__dirname, '..', 'aliases.json'),
        game_devices: config.paths.gameDevices,
        ai_devices: config.paths.aiDevices
    };

    // 初始化所有文件
    static initializeAll() {
        Logger.info('Persistence', '启动数据文件初始化流程...');

        let allValid = true;
        for (const [name, filePath] of Object.entries(this.FILES)) {
            const isValid = this.ensureFileExists(name, filePath);
            if (!isValid) allValid = false;
        }

        if (allValid) {
            Logger.info('Persistence', '✅ 所有数据文件初始化完毕');
        } else {
            Logger.warn('Persistence', '⚠️ 部分文件初始化过程中发生问题，已使用默认值');
        }
    }

    // 确保单个文件存在且有效
    static ensureFileExists(name, filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                Logger.warn('Persistence', `文件不存在，创建: ${name}`);
                const template = this.TEMPLATES[name];
                const content = typeof template === 'object' ? JSON.stringify(template, null, 2) : template;
                fs.writeFileSync(filePath, content, 'utf8');
                return true;
            }

            // 文件存在，检查内容有效性
            if (name.includes('_devices') || name === 'aliases') {
                const content = fs.readFileSync(filePath, 'utf8').trim();

                // 设备文件为空或损坏，重置为模板
                if (!content) {
                    Logger.warn('Persistence', `文件为空，重置为模板: ${name}`);
                    const template = this.TEMPLATES[name];
                    const newContent = typeof template === 'object' ? JSON.stringify(template, null, 2) : template;
                    fs.writeFileSync(filePath, newContent, 'utf8');
                    return true;
                }
                return true;
            }

            // JSON文件有效性检查
            if (name === 'device_custom') {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    if (!content.trim()) {
                        fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8');
                        return true;
                    }
                    JSON.parse(content); // 验证JSON格式
                    return true;
                } catch (e) {
                    Logger.warn('Persistence', `文件损坏或JSON格式错误，重置: ${name}`);
                    fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8');
                    return false;
                }
            }

            return true;
        } catch (err) {
            Logger.error('Persistence', `初始化文件 ${name} 失败`, err);
            return false;
        }
    }

    // 创建备份
    static backup(filePath) {
        try {
            const backupPath = `${filePath}.bak`;
            if (fs.existsSync(filePath)) {
                fs.copyFileSync(filePath, backupPath);
                return true;
            }
            return false;
        } catch (err) {
            Logger.warn('Persistence', `备份文件失败: ${filePath}`, err);
            return false;
        }
    }

    // 从备份恢复
    static restore(filePath) {
        try {
            const backupPath = `${filePath}.bak`;
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, filePath);
                Logger.info('Persistence', `已从备份恢复: ${filePath}`);
                return true;
            }
            Logger.warn('Persistence', `备份文件不存在: ${backupPath}`);
            return false;
        } catch (err) {
            Logger.error('Persistence', `恢复文件失败: ${filePath}`, err);
            return false;
        }
    }

    // 安全读取JSON文件
    static readJSON(filePath, defaultValue = {}) {
        try {
            if (!fs.existsSync(filePath)) {
                return defaultValue;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            if (!content.trim()) {
                return defaultValue;
            }
            return JSON.parse(content);
        } catch (err) {
            Logger.warn('Persistence', `读取JSON失败: ${filePath}`, err);
            // 尝试从备份恢复
            const backupPath = `${filePath}.bak`;
            if (fs.existsSync(backupPath)) {
                try {
                    return JSON.parse(fs.readFileSync(backupPath, 'utf8'));
                } catch (e) {
                    Logger.warn('Persistence', `备份文件也损坏: ${backupPath}`);
                }
            }
            return defaultValue;
        }
    }

    // 安全写入JSON文件
    static writeJSON(filePath, data) {
        try {
            // 先备份
            this.backup(filePath);
            // 再写入
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            Logger.error('Persistence', `写入JSON失败: ${filePath}`, err);
            return false;
        }
    }

    // 安全读取文本文件
    static readText(filePath, defaultValue = '') {
        try {
            if (!fs.existsSync(filePath)) {
                return defaultValue;
            }
            return fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            Logger.warn('Persistence', `读取文本失败: ${filePath}`, err);
            // 尝试从备份恢复
            const backupPath = `${filePath}.bak`;
            if (fs.existsSync(backupPath)) {
                try {
                    return fs.readFileSync(backupPath, 'utf8');
                } catch (e) {
                    Logger.warn('Persistence', `备份文件也无法读取: ${backupPath}`);
                }
            }
            return defaultValue;
        }
    }

    // 安全写入文本文件
    static writeText(filePath, data) {
        try {
            // 先备份
            this.backup(filePath);
            // 再写入
            fs.writeFileSync(filePath, data, 'utf8');
            return true;
        } catch (err) {
            Logger.error('Persistence', `写入文本失败: ${filePath}`, err);
            return false;
        }
    }

    // 数据完整性检查
    static checkIntegrity() {
        const report = {
            timestamp: new Date().toISOString(),
            files: {}
        };

        for (const [name, filePath] of Object.entries(this.FILES)) {
            const fileReport = {
                exists: fs.existsSync(filePath),
                size: 0,
                valid: false,
                backupExists: fs.existsSync(`${filePath}.bak`)
            };

            if (fileReport.exists) {
                try {
                    const stat = fs.statSync(filePath);
                    fileReport.size = stat.size;

                    if (name === 'device_custom') {
                        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        fileReport.valid = true;
                        fileReport.itemCount = Object.keys(data).length;
                    } else if (name === 'aliases') {
                        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        fileReport.valid = true;
                        fileReport.itemCount = Object.keys(data).length;
                    } else {
                        const content = fs.readFileSync(filePath, 'utf8').trim();
                        fileReport.valid = true;
                        fileReport.itemCount = content.split('\n').filter(l => l.trim()).length;
                    }
                } catch (e) {
                    fileReport.valid = false;
                    fileReport.error = e.message;
                }
            }

            report.files[name] = fileReport;
        }

        return report;
    }

    // 打印完整性报告
    static logIntegrityReport() {
        const report = this.checkIntegrity();
        Logger.info('Persistence', '数据完整性检查报告:');
        for (const [name, info] of Object.entries(report.files)) {
            const status = info.valid ? '✅' : '❌';
            Logger.info('Persistence', `  ${status} ${name}: ${info.size}B, valid=${info.valid}, items=${info.itemCount || 0}, backup=${info.backupExists}`);
        }
    }
}

module.exports = PersistenceService;
