const SshService = require('../services/sshService');
const StorageCleanupService = require('../services/storageCleanupService');
const Logger = require('../utils/logger');

class ClashApiProxy {
    // Caches
    static _cachedProxies = null;
    static _cachedProxiesTime = 0;
    static _cachedVersion = null;
    static _cachedVersionTime = 0;

    static _proxiesCacheTTL = 10000;   // 10 seconds
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

    // 获取所有代理节点（带10s缓存，避免每次/status触发SSH）
    static async getProxies(timeoutMs = 5000) {
        const now = Date.now();
        if (this._cachedProxies && (now - this._cachedProxiesTime < this._proxiesCacheTTL)) {
            return this._cachedProxies;
        }
        const data = await this.fetchViaSSH('/proxies');
        this._cachedProxies = data;
        this._cachedProxiesTime = now;
        return data;
    }

    // 获取规则集
    static async getRules(timeoutMs = 5000) {
        return this.fetchViaSSH('/rules');
    }

    // 测试单个节点延迟
    static async testNodeDelay(nodeName, timeoutMs = 4000, testUrl = 'http://www.gstatic.com/generate_204') {
        try {
            const encodedName = encodeURIComponent(nodeName);
            const encodedUrl = encodeURIComponent(testUrl);
            const endpoint = `/proxies/${encodedName}/delay?timeout=${Math.max(timeoutMs - 1000, 1000)}&url=${encodedUrl}`;
            const result = await this.fetchViaSSH(endpoint);
            return result.delay || 0;
        } catch (err) {
            Logger.debug('ClashApiProxy', `Node delay test failed for ${nodeName}`);
            return 0;
        }
    }

    // 选择/切换代理节点
    static async selectProxyNode(groupName, nodeName, timeoutMs = 3000) {
        try {
            const encodedGroup = encodeURIComponent(groupName);
            const jsonData = JSON.stringify({ name: nodeName });
            // 需要转义用于 shell 命令
            const escapedData = jsonData.replace(/'/g, "'\\''");

            // 使用 curl -d 和 PUT 方法
            const curlCmd = `curl -s -X PUT -d '${escapedData}' http://127.0.0.1:9999/proxies/${encodedGroup}`;
            await SshService.runRemoteCommand(curlCmd);

            Logger.info('ClashApiProxy', `Successfully selected ${nodeName} for group ${groupName}`);
            return true;
        } catch (err) {
            Logger.error('ClashApiProxy', `Failed to select proxy node`, err.message);
            return false;
        }
    }
}

module.exports = ClashApiProxy;

