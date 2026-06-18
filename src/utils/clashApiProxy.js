const SshService = require('../services/sshService');
const Logger = require('../utils/logger');

class ClashApiProxy {
    // 通过SSH在路由器上执行curl命令获取Clash API响应
    static async fetchViaSSH(endpoint) {
        try {
            // 使用 SshService 执行 curl 命令在路由器上
            const curlCmd = `curl -s http://127.0.0.1:9999${endpoint}`;
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

    // 获取版本信息
    static async getVersion(timeoutMs = 3000) {
        return this.fetchViaSSH('/version');
    }

    // 获取配置
    static async getConfigs(timeoutMs = 3000) {
        return this.fetchViaSSH('/configs');
    }

    // 获取所有代理节点
    static async getProxies(timeoutMs = 5000) {
        return this.fetchViaSSH('/proxies');
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

