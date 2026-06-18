const SshService = require('./sshService');
const ClashService = require('./clashService');
const Logger = require('../utils/logger');
const { config } = require('../config');

let proxyHealthMonitorTimer = null;
let consecutiveFailures = 0;

class ProxyHealthService {
    // 检测路由器本地指定 TCP 端口是否在监听
    static async checkPortListeningLocal(port) {
        try {
            const output = await SshService.runRemoteCommand(`netstat -nlt | grep -E ":${port}\\b"`);
            return output.trim().length > 0;
        } catch (e) {
            return false;
        }
    }

    // 通过路由器本地的指定代理端口进行测试连接
    static async testProxyConnectivity(port, url, timeoutMs) {
        try {
            const timeoutSec = Math.ceil(timeoutMs / 1000);
            // 使用 -s 避免进度条干扰，-k 忽略 CA 校验
            const cmd = `curl -I -s -k --connect-timeout ${timeoutSec} --max-time ${timeoutSec + 1} -x http://127.0.0.1:${port} ${url} | head -n 1`;
            const res = await SshService.runRemoteCommand(cmd);
            return res.includes('HTTP/');
        } catch (e) {
            return false;
        }
    }

    // 向 Clash 核心下发触发指定 provider 测速的请求，以驱动节点自动漂移
    static async triggerProviderHealthCheck(providerName) {
        try {
            // 使用 curl 远程调用 localhost 的 Clash 接口触发测速
            await SshService.runRemoteCommand(`curl -s http://127.0.0.1:${config.ports.clash}/providers/proxies/${providerName}/healthcheck`);
            Logger.info('ProxyDaemon', `已成功向 Clash 核心下发 ${providerName} 节点重新测速自愈请求。`);
        } catch (e) {
            Logger.error('ProxyDaemon', '触发节点自愈测速失败', e);
        }
    }

    // 启动代理模式全局健康自愈监测器
    static startProxyHealthMonitor() {
        if (proxyHealthMonitorTimer) return;

        Logger.info('ProxyDaemon', '🛡️ 启动网页代理全局健康度自愈监测守护进程...');
        consecutiveFailures = 0;

        // 初始化预热：第一次心跳延迟30s执行，给系统充足的启动和初始化时间
        setTimeout(() => this._runHealthCheck(), 30000);

        // 之后每60秒轮询一次
        proxyHealthMonitorTimer = setInterval(() => this._runHealthCheck(), 60000);
        Logger.info('ProxyDaemon', '心跳检测已启动 (30s初始延迟，之后每60s检测一次)');
    }

    // 内部实现：单次心跳检测
    static async _runHealthCheck() {
        try {
            // 重启冷却期：重启后 90s 内不执行检测（给进程充足的初始化时间）
            const lastRestartTime = SshService.getLastRestartTime?.() || 0;
            const timeSinceLastRestart = Date.now() - lastRestartTime;
            if (timeSinceLastRestart < 90000) {
                Logger.debug('ProxyDaemon', `处于重启冷却期 (${Math.floor((90000 - timeSinceLastRestart) / 1000)}s 剩余)`);
                return;
            }

            // 1. 检查 Clash Core 进程（支持多种进程名）
            const pidOutput = await SshService.runRemoteCommand('pidof CrashCore || pidof crashcore || pidof Clash || pgrep -f "CrashCore|crashcore" || true');
            const isProcessRunning = pidOutput.trim().length > 0 && !pidOutput.includes('Error');

            if (!isProcessRunning) {
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/2] 检测到 Clash Core 进程已异常退出`);
                if (consecutiveFailures >= 2) {
                    Logger.warn('ProxyDaemon', '触发强制自愈拉起...');
                    await SshService.restartShellCrashSecurely();
                    consecutiveFailures = 0;
                }
                return;
            }

            // 2. 检查代理端口是否健康监听（关键）
            const isPortListening = await this.checkPortListeningLocal(config.ports.proxy);
            if (!isPortListening) {
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/2] 检测到核心代理端口 ${config.ports.proxy} 假死/未开启`);
                if (consecutiveFailures >= 2) {
                    Logger.warn('ProxyDaemon', '触发强制修复...');
                    await SshService.restartShellCrashSecurely();
                    consecutiveFailures = 0;
                }
                return;
            }

            // 3. 检查海外代理链路可用性
            const isProxyWorking = await this.testProxyConnectivity(config.ports.proxy, 'http://cp.cloudflare.com/generate_204', 4000);
            if (!isProxyWorking) {
                Logger.warn('ProxyDaemon', '⚠️ 检测到网页代理链路超时阻断！已触发机场节点重新并发测速以引导自动节点漂移自愈...');
                let providerName = 'caomei1';
                try {
                    const providerOutput = await SshService.runRemoteCommand("grep -A 1 'proxy-providers:' /data/ShellCrash/yamls/config.yaml | tail -n 1 | cut -d: -f1 | tr -d ' '");
                    if (providerOutput && providerOutput.trim().length > 0 && !providerOutput.includes('Error')) {
                        providerName = providerOutput.trim();
                    }
                } catch (pErr) {
                    Logger.warn('ProxyDaemon', '自愈程序获取 proxy-provider 失败，使用 caomei1', pErr);
                }
                await this.triggerProviderHealthCheck(providerName);
                consecutiveFailures = 0;
            } else {
                consecutiveFailures = 0;
                Logger.debug('ProxyDaemon', '✅ 全部检测通过');
            }
        } catch (err) {
            Logger.error('ProxyDaemon', '自愈守护进程心跳检测发生异常', err);
            consecutiveFailures++;
        }
    }

    // 关闭监测器
    static stopProxyHealthMonitor() {
        if (proxyHealthMonitorTimer) {
            clearInterval(proxyHealthMonitorTimer);
            proxyHealthMonitorTimer = null;
            Logger.info('ProxyDaemon', '⏹️ 网页代理健康度监测守护进程已关闭。');
        }
    }
}

module.exports = ProxyHealthService;
