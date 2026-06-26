const SshService = require('../services/sshService');
const StorageCleanupService = require('../services/storageCleanupService');
const Logger = require('../utils/logger');

class ClashApiProxy {
    // Version cache
    static _cachedVersion = null;
    static _cachedVersionTime = 0;
    static _versionCacheTTL = 30000;   // 30 seconds
    // 通过SSH在路由器上执行curl命令获取Clash API响应（带超时）
    static async fetchViaSSH(endpoint, timeoutMs = 5000) {
        try {
            // 检查并清理磁盘空间（实时防护）
            await StorageCleanupService.checkAndCleanupIfNeeded();

            // 添加curl超时：connect-timeout连接超时 + max-time总超时
            const connectTimeout = Math.ceil(timeoutMs / 1000);
            const curlCmd = `curl -s --connect-timeout ${connectTimeout} --max-time ${connectTimeout + 1} http://127.0.0.1:9999${endpoint}`;

            const output = await SshService.runRemoteCommand(curlCmd);

            if (!output || output.trim().length === 0) {
                Logger.debug('ClashApiProxy', `Empty response from endpoint: ${endpoint}`);
                throw new Error('Empty response from Clash API');
            }

            // 尝试解析JSON响应
            try {
                return JSON.parse(output);
            } catch (parseErr) {
                Logger.warn('ClashApiProxy', `Failed to parse JSON from endpoint ${endpoint}:`, output.substring(0, 200));
                throw new Error(`Invalid JSON response from Clash API`);
            }
        } catch (err) {
            Logger.error('ClashApiProxy', `Failed to fetch ${endpoint} via SSH`, err.message);
            throw err;
        }
    }

    // 获取版本信息（带30s缓存，版本不会频繁变化）
    static async getVersion(timeoutMs = 3000) {
        const now = Date.now();
        if (this._cachedVersion && (now - this._cachedVersionTime < this._versionCacheTTL)) {
            return this._cachedVersion;
        }
        const data = await this.fetchViaSSH('/version');
        this._cachedVersion = data;
        this._cachedVersionTime = now;
        return data;
    }

    // 获取配置
    static async getConfigs(timeoutMs = 3000) {
        return this.fetchViaSSH('/configs');
    }
}

module.exports = ClashApiProxy;

