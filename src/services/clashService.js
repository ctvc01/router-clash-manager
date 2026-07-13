const axios = require('axios');
const { config } = require('../config');
const Logger = require('../utils/logger');

let cachedProxies = null;
let lastProxiesFetchTime = 0;
let pendingProxiesPromise = null;
const PROXIES_CACHE_TTL = 10000; // 10秒缓存
let delayTestQueue = Promise.resolve(); // 全局测速串行 Promise 队列
let fullSpeedtestInProgress = false; // 全量测速进行中标记，定时任务据此跳过执行

// 通用 hard-timeout 包装：给测速队列每一环强加 wall-clock 上限，
// 避免 axios 底层异常导致某环永不 settle 而堵死后续所有测速
function withHardTimeout(promise, ms, tag) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} 超过 ${ms}ms 硬超时`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

class ClashService {
    // 查询当前是否有全量测速正在进行
    static isFullSpeedtestInProgress() {
        return fullSpeedtestInProgress;
    }

    // 标记全量测速开始/结束
    static setFullSpeedtestFlag(active) {
        fullSpeedtestInProgress = active;
    }

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
    static async getProxies(timeoutMs = 5000, nocache = false) {
        const now = Date.now();
        if (!nocache && cachedProxies && (now - lastProxiesFetchTime < PROXIES_CACHE_TTL)) {
            return cachedProxies;
        }
        if (!nocache && pendingProxiesPromise) {
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

    // 测试单个节点延迟 (全局串行队列保护，保证对路由器零并发冲击)
    static testNodeDelay(nodeName, timeoutMs = 3000, testUrl = 'http://www.gstatic.com/generate_204') {
        return new Promise((resolve) => {
            // 串行队列
            // 单节点测速本身 timeoutMs 有上限，队列环再套一层 wall-clock 兜底（+2s 富裕）
            const queueSlotTimeoutMs = Math.max(5000, timeoutMs + 2000);
            const chained = delayTestQueue.then(async () => {
                try {
                    const encodedName = encodeURIComponent(nodeName);
                    const apiTimeout = Math.max(1000, timeoutMs - 1000);
                    const url = `/proxies/${encodedName}/delay?timeout=${apiTimeout}&url=${encodeURIComponent(testUrl)}`;
                    const res = await this._request('GET', url, null, timeoutMs);
                    if (res && res.status === 200) {
                        resolve(res.data.delay || 0);
                        return;
                    }
                    resolve(0);
                } catch (err) {
                    Logger.debug('ClashAPI', `节点 [${nodeName}] 测速请求失败: ${err.message}`);
                    resolve(0);
                }
            });

            // 用 hard-timeout 保护整个队列环；即便调用者已经 resolve(0)，也确保链路不 hang
            delayTestQueue = withHardTimeout(chained, queueSlotTimeoutMs, `testNodeDelay[${nodeName}]`).catch(err => {
                Logger.error('ClashAPI', `测速队列未捕获异常: ${err.message}`);
                resolve(0);
                // 不 rethrow：让 delayTestQueue 复位到 resolved，防止一次超时堵死后续所有测速
            });
        });
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

    // 通过 Clash HTTP API 平滑热重载配置 (Zero-Downtime Hot Reload)
    static async hotReloadConfig(configPath = '/data/ShellCrash/config.yaml', timeoutMs = 20000) {
        try {
            Logger.info('ClashAPI', `正在请求内核平滑热重载配置: ${configPath}`);
            const res = await this._request('PUT', '/configs?force=false', { path: configPath }, timeoutMs);
            if (res.status === 204 || res.status === 200 || res.status === 202) {
                Logger.info('ClashAPI', '✅ 配置热重载成功，当前网络连接未中断！');
                return true;
            }
            Logger.warn('ClashAPI', `配置热重载返回意外状态码: ${res.status}`);
            return false;
        } catch (error) {
            Logger.error('ClashAPI', `配置热重载请求异常: ${error.message}`);
            return false;
        }
    }

    // 触发指定 proxy-provider 的健康测速
    static async triggerProviderHealthCheck(providerName, timeoutMs = 5000) {
        const encodedProvider = encodeURIComponent(providerName);
        const url = `/providers/proxies/${encodedProvider}/healthcheck`;
        try {
            const res = await this._request('GET', url, null, timeoutMs);
            if (res.status === 204 || res.status === 200) {
                Logger.info('ClashAPI', `成功触发 ${providerName} 节点测速`);
                return true;
            }
            throw new Error(`API 返回状态码: ${res.status}`);
        } catch (error) {
            Logger.error('ClashAPI', `触发 ${providerName} 测速失败: ${error.message}`);
            return false;
        }
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
}

module.exports = ClashService;
