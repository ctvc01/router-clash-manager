const axios = require('axios');
const { config } = require('../config');
const Logger = require('../utils/logger');

let cachedProxies = null;
let lastProxiesFetchTime = 0;
let pendingProxiesPromise = null;
const PROXIES_CACHE_TTL = 10000; // 10秒缓存

class ClashService {
    // 获取 Clash (Mihomo) HTTP 客户端实例
    static _getClient(timeoutMs = 5000) {
        const baseURL = `http://${config.router.ip}:${config.ports.clash}`;
        return axios.create({
            baseURL,
            timeout: timeoutMs,
            validateStatus: () => true // 所有状态码都作为 resolved 处理，自行判断
        });
    }

    // 基础 HTTP 请求包装，提供异常处理
    static async _request(method, url, data = null, timeoutMs = 5000) {
        const client = this._getClient(timeoutMs);
        try {
            const response = await client.request({ method, url, data });
            return response;
        } catch (error) {
            Logger.error('ClashAPI', `HTTP 请求错误 [${method}] ${url}: ${error.message}`);
            throw error;
        }
    }

    // 获取 Clash 版本信息
    static async getVersion(timeoutMs = 3000) {
        const res = await this._request('GET', '/version', null, timeoutMs);
        if (res.status === 200) {
            return res.data;
        }
        throw new Error(`获取版本失败，API 返回状态码: ${res.status}`);
    }

    // 获取 Clash 配置
    static async getConfigs(timeoutMs = 3000) {
        const res = await this._request('GET', '/configs', null, timeoutMs);
        if (res.status === 200) {
            return res.data;
        }
        throw new Error(`获取配置失败，API 返回状态码: ${res.status}`);
    }

    // 获取所有代理节点信息 (带有 10 秒防抖和合并请求缓存，防止路由器 OOM)
    static async getProxies(timeoutMs = 5000) {
        const now = Date.now();
        if (cachedProxies && (now - lastProxiesFetchTime < PROXIES_CACHE_TTL)) {
            return cachedProxies;
        }
        if (pendingProxiesPromise) {
            return pendingProxiesPromise;
        }

        pendingProxiesPromise = (async () => {
            try {
                const res = await this._request('GET', '/proxies', null, timeoutMs);
                if (res.status === 200) {
                    cachedProxies = res.data;
                    lastProxiesFetchTime = Date.now();
                    return cachedProxies;
                }
                throw new Error(`获取代理节点失败，API 返回状态码: ${res.status}`);
            } finally {
                pendingProxiesPromise = null;
            }
        })();

        return pendingProxiesPromise;
    }

    // 清除代理信息缓存
    static clearProxiesCache() {
        cachedProxies = null;
        lastProxiesFetchTime = 0;
        Logger.info('ClashAPI', '已清除节点 proxies 缓存');
    }

    // 测试单个节点延迟
    static async testNodeDelay(nodeName, timeoutMs = 4000, testUrl = 'http://ctest.cdn.nintendo.net/') {
        const encodedName = encodeURIComponent(nodeName);
        const url = `/proxies/${encodedName}/delay?timeout=${timeoutMs - 1000}&url=${encodeURIComponent(testUrl)}`;
        const res = await this._request('GET', url, null, timeoutMs);
        if (res.status === 200) {
            return res.data.delay || 0;
        }
        return 0;
    }

    // 锁定/选择特定的策略组节点
    static async selectProxyNode(groupName, nodeName, timeoutMs = 3000) {
        const encodedGroup = encodeURIComponent(groupName);
        const url = `/proxies/${encodedGroup}`;
        const data = { name: nodeName };
        const res = await this._request('PUT', url, data, timeoutMs);
        if (res.status === 204) {
            Logger.info('ClashAPI', `成功将策略组 [${groupName}] 锁定到节点: ${nodeName}`);
            return true;
        }
        Logger.error('ClashAPI', `锁定策略组失败，状态码: ${res.status}`);
        return false;
    }

    // 轮询等待 Clash 核心就绪 (1053/9999 端口恢复响应)
    static async waitClashReady(maxAttempts = 15) {
        Logger.info('ClashAPI', '开始轮询等待 Clash 核心就绪...');
        this.clearProxiesCache(); // 强制清理旧的节点缓存
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const data = await this.getVersion(800);
                if (data && data.version) {
                    Logger.info('ClashAPI', 'Clash 核心就绪成功！');
                    return true;
                }
            } catch (e) {
                // 忽略错误，等待下一次轮询
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        Logger.warn('ClashAPI', `Clash 核心在尝试 ${maxAttempts} 次后仍未就绪。`);
        return false;
    }

    // 通用指数退避重试执行器
    static async runWithRetry(fn, maxRetries = 3, delayMs = 500) {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                if (i > 0) {
                    Logger.debug('Retry', `正在进行第 ${i + 1}/${maxRetries} 次重试尝试...`);
                }
                return await fn();
            } catch (err) {
                lastError = err;
                Logger.warn('Retry', `重试任务第 ${i + 1} 次尝试失败: ${err.message}`);
                if (i < maxRetries - 1) {
                    // 指数退避：500ms, 1000ms, 2000ms...
                    const waitTime = delayMs * Math.pow(2, i);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }
        throw lastError;
    }
}

module.exports = ClashService;
