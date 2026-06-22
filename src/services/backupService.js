const fs = require('fs');
const path = require('path');
const SshService = require('./sshService');
const { config } = require('../config');
const Logger = require('../utils/logger');
const PersistenceService = require('./persistenceService');

class BackupService {
    // 物理备份根目录
    static BACKUP_DIR = config.paths.configsBackup;
    static NAS_BACKUP_DIR = path.join(this.BACKUP_DIR, 'nas');
    static ROUTER_BACKUP_DIR = path.join(this.BACKUP_DIR, 'router');

    // 确保备份目录存在
    static ensureBackupDirs() {
        try {
            if (!fs.existsSync(this.BACKUP_DIR)) {
                fs.mkdirSync(this.BACKUP_DIR, { recursive: true });
            }
            if (!fs.existsSync(this.NAS_BACKUP_DIR)) {
                fs.mkdirSync(this.NAS_BACKUP_DIR, { recursive: true });
            }
            if (!fs.existsSync(this.ROUTER_BACKUP_DIR)) {
                fs.mkdirSync(this.ROUTER_BACKUP_DIR, { recursive: true });
            }
        } catch (err) {
            Logger.error('Backup', '创建本地备份目录失败', err);
        }
    }

    // 执行一次物理备份镜像到 configs_backup/ 目录（用于 NAS 容器内部自愈与物理同步）
    static async performBackup() {
        try {
            Logger.info('Backup', '开始执行自动配置备份...');
            this.ensureBackupDirs();

            // 1. 备份 NAS 本地持久化文件
            const nasFiles = PersistenceService.FILES;
            for (const [name, sourcePath] of Object.entries(nasFiles)) {
                if (fs.existsSync(sourcePath)) {
                    const destPath = path.join(this.NAS_BACKUP_DIR, path.basename(sourcePath));
                    fs.copyFileSync(sourcePath, destPath);
                }
            }
            Logger.debug('Backup', 'NAS 端配置已复制至 configs_backup/nas/');

            // 2. 备份路由器端配置
            let routerConfig = '';
            let routerMac = '';
            try {
                routerConfig = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
                routerMac = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');

                if (routerConfig.trim()) {
                    fs.writeFileSync(path.join(this.ROUTER_BACKUP_DIR, 'config.yaml'), routerConfig, 'utf8');
                }
                if (routerMac.trim()) {
                    fs.writeFileSync(path.join(this.ROUTER_BACKUP_DIR, 'mac'), routerMac, 'utf8');
                }
                Logger.debug('Backup', '路由器端配置已拉取并存至 configs_backup/router/');
            } catch (sshErr) {
                Logger.warn('Backup', '备份时连接路由器 SSH 失败，跳过路由器端配置备份', sshErr);
            }

            Logger.info('Backup', '✅ 自动配置备份已完成');
            return true;
        } catch (err) {
            Logger.error('Backup', '自动配置备份发生异常', err);
            return false;
        }
    }

    // 提供给手动/Mac 脚本下载的聚合配置数据包
    static async getAggregatedBackup() {
        this.ensureBackupDirs();

        const data = {
            router: {
                config: '',
                mac: ''
            },
            nas: {
                device_custom: '',
                game_devices: '',
                ai_devices: '',
                aliases: ''
            }
        };

        // 1. 获取路由器配置
        try {
            data.router.config = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
            data.router.mac = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        } catch (sshErr) {
            Logger.warn('Backup', '聚合备份拉取路由器配置失败，使用本地已有的 configs_backup 历史配置兜底', sshErr);
            const localConfigPath = path.join(this.ROUTER_BACKUP_DIR, 'config.yaml');
            const localMacPath = path.join(this.ROUTER_BACKUP_DIR, 'mac');
            if (fs.existsSync(localConfigPath)) data.router.config = fs.readFileSync(localConfigPath, 'utf8');
            if (fs.existsSync(localMacPath)) data.router.mac = fs.readFileSync(localMacPath, 'utf8');
        }

        // 2. 获取 NAS 本地配置
        const nasFiles = PersistenceService.FILES;
        for (const [name, sourcePath] of Object.entries(nasFiles)) {
            if (fs.existsSync(sourcePath)) {
                data.nas[name] = fs.readFileSync(sourcePath, 'utf8');
            }
        }

        return data;
    }
}

module.exports = BackupService;
