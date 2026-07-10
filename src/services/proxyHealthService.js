const SshService = require('./sshService');
const ClashService = require('./clashService');
const Logger = require('../utils/logger');
const { config } = require('../config');

let proxyHealthMonitorTimer = null;
let proxyHealthStartTimeout = null; // 心跳启动延时器
let trickleNodes = [];              // 涓流测速当前轮次的节点列表
let trickleIndex = 0;               // 涓流测速游标
let trickleTimer = null;            // 涓流测速定时器
let trickleStartTimeout = null;     // 涓流测速启动延时器
let consecutiveFailures = 0;
let consecutiveRestarts = 0; // 连续重启计数器，防止级联雪崩
let lastProxyRestartTime = 0; // 本地追踪最近重启时间（不依赖 SshService）

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
       // 主方案：NAS 本地 Axios 代理测试（零 SSH 开销）
       try {
           const axios = require('axios');
           const startTime = Date.now();
           const response = await axios({
               method: 'HEAD',
               url: url,
               timeout: timeoutMs,
               proxy: {
                   host: config.router.ip,
                   port: port
               },
               maxRedirects: 0,
               validateStatus: () => true
           });
           const elapsed = Date.now() - startTime;
           Logger.debug('ProxyDaemon', `本地 Axios 代理测试完成: status=${response.status} (${elapsed}ms)`);
           // 任何 HTTP 状态响应（含 4xx/5xx）都说明代理通道存活
           return true;
       } catch (e) {
           Logger.debug('ProxyDaemon', `本地 Axios 代理测试失败: ${e.message}，降级 SSH 远程测试`);
       }

       // 降级方案：SSH 远程 curl（网络桥接等边缘场景）
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
        Logger.info('ProxyDaemon', `正在触发 ${providerName} 节点重新测速自愈请求...`);
        const success = await ClashService.triggerProviderHealthCheck(providerName);
        if (success) {
            Logger.info('ProxyDaemon', `已成功向 Clash 核心下发 ${providerName} 节点重新测速自愈请求 (HTTP API)。`);
        } else {
            // API 失败则降级使用 SSH curl
            try {
                Logger.warn('ProxyDaemon', 'HTTP API 触发测速失败，正在尝试通过 SSH 降级触发...');
                await SshService.runRemoteCommand(`curl -s http://127.0.0.1:${config.ports.clash}/providers/proxies/${providerName}/healthcheck`);
                Logger.info('ProxyDaemon', '已成功通过 SSH 降级下发测速请求');
            } catch (sshErr) {
                Logger.error('ProxyDaemon', 'SSH 降级触发自愈测速失败', sshErr);
            }
        }
    }

    // 启动代理模式全局健康自愈监测器 (错峰调度与定时全节点检测)
    static startProxyHealthMonitor() {
        if (proxyHealthMonitorTimer || proxyHealthStartTimeout) return;

        Logger.info('ProxyDaemon', '🛡️ 网页代理全局健康度自愈监测守护进程排程中...');
        consecutiveFailures = 0;

        // 1. 心跳检测：启动后延迟 180 秒（3分钟）正式激活，每 10 分钟轮询一次
        proxyHealthStartTimeout = setTimeout(() => {
            proxyHealthStartTimeout = null;
            Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测正式启动 (周期 10 分钟)');
            this._runHealthCheckScheduler();
        }, 180000);
        Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测已排程，将在 180 秒后错峰激活 (周期 10 分钟)');

        // 2. 网页代理全节点涓流测速任务：启动后延迟 5 分钟正式激活，每 5 分钟测 1 个节点
        if (!trickleTimer && !trickleStartTimeout) {
            trickleStartTimeout = setTimeout(() => {
                trickleStartTimeout = null;
                Logger.info('ProxyDaemon', '🕰️ 网页代理全节点涓流测速任务正式启动 (周期 5 分钟/节点)');
                this.runTrickleNodeCheck();

                trickleTimer = setInterval(() => {
                    this.runTrickleNodeCheck();
                }, 300000);
            }, 600000);
            Logger.info('ProxyDaemon', '🕰️ 网页代理全节点涓流测速已排程，将在 10 分钟后激活 (周期 5 分钟/节点)');
        }
    }

   // 自适应调度器：健康时 10min 周期，异常时 30s 快速重检
   static async _runHealthCheckScheduler() {
        const startTime = Date.now();
        try {
            const isHealthy = await this._runHealthCheck();
            const elapsed = Date.now() - startTime;
            // 健康 -> 10min 周期；异常 -> 30s 快速重检
            const nextInterval = isHealthy ? 600000 : 30000;
            Logger.debug('ProxyDaemon', `心跳检测完成 (${elapsed}ms) ${isHealthy ? '✅ 健康' : '⚠️ 异常，30s后快速重检'}`);
            proxyHealthMonitorTimer = setTimeout(() => this._runHealthCheckScheduler(), nextInterval);
        } catch (e) {
            Logger.error('ProxyDaemon', '调度器捕获到未处理心跳异常', e);
            // 异常也 30s 快速重试
            proxyHealthMonitorTimer = setTimeout(() => this._runHealthCheckScheduler(), 30000);
        }
    }

    // 内部实现：单次心跳检测，返回 true=健康 false=有异常
    static async _runHealthCheck() {
        try {
            // 重启冷却期：重启后 90s 内不执行检测
            const timeSinceLastRestart = Date.now() - lastProxyRestartTime;
            if (timeSinceLastRestart < 90000) {
                Logger.debug('ProxyDaemon', `处于重启冷却期 (${Math.floor((90000 - timeSinceLastRestart) / 1000)}s 剩余)`);
                return true; // 冷却期认为健康
            }

            let hasIssue = false; // 跟踪是否有任何异常

            // === [BATCH QUERY] 一次 SSH 查询获取 4 项状态 ===
            const batchCmd = [
                `echo "BATCH_START"`,
                `echo "PID:$(pidof mihomo 2>/dev/null || pidof Clash 2>/dev/null || pidof CrashCore 2>/dev/null || pgrep -x mihomo 2>/dev/null || pgrep -x Clash 2>/dev/null || pgrep -x CrashCore 2>/dev/null || echo 'no_pid')"`,
                `echo "PORT:$(netstat -nlt 2>/dev/null | grep -q ':${config.ports.proxy}' && echo ok || echo down)"`,
                `echo "MAC:$([ -s /data/ShellCrash/configs/mac ] && echo yes || echo no)"`,
                `echo "IPT:$(iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c REDIRECT || echo 0)"`,
                `echo "BATCH_END"`
            ].join('; ');

            const batchOutput = await SshService.runRemoteCommand(batchCmd);
            const batchLines = batchOutput.split('\n').map(l => l.trim()).filter(l => l);
            const batchStart = batchLines.findIndex(l => l.includes('BATCH_START'));
            const batchEnd = batchLines.findIndex(l => l.includes('BATCH_END'));

            let pid = '', portStatus = '', macStatus = '', redirectCount = 0;

            if (batchStart >= 0 && batchEnd > batchStart) {
                const dataLines = batchLines.slice(batchStart + 1, batchEnd);
                for (const dl of dataLines) {
                    if (dl.startsWith('PID:')) pid = dl.slice(4).trim();
                    else if (dl.startsWith('PORT:')) portStatus = dl.slice(5).trim();
                    else if (dl.startsWith('MAC:')) macStatus = dl.slice(4).trim();
                    else if (dl.startsWith('IPT:')) redirectCount = parseInt(dl.slice(4).trim(), 10) || 0;
                }
            }

            const isProcessRunning = pid && pid.length > 0 && pid !== 'no_pid' && !pid.includes('Error');
            const isPortListening = portStatus === 'ok';
            const hasProxyOrGame = macStatus === 'yes';

            // 1. 检查 Clash Core 进程
            if (!isProcessRunning) {
                hasIssue = true;
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/3] 检测到 Clash Core 进程已异常退出`);

                let isJustBooted = false;
                try {
                    const uptimeStr = await SshService.runRemoteCommand("cat /proc/uptime | awk '{print $1}'");
                    const uptimeSec = parseFloat(uptimeStr);
                    if (!isNaN(uptimeSec) && uptimeSec < 300) {
                        isJustBooted = true;
                        Logger.warn('ProxyDaemon', `🚀 检测到路由器刚开机仅 ${Math.floor(uptimeSec)}s，跳过防抖等待，立即执行闪电自愈！`);
                    }
                } catch (e) {}

                if ((consecutiveFailures >= 3 || isJustBooted) && Date.now() - lastProxyRestartTime > 300000) {
                    if (consecutiveRestarts >= 3) {
                        Logger.error('ProxyDaemon', '❌ 已经连续安全重启服务 3 次仍未恢复！疑似外网物理断开或订阅失效。为保护路由器 CPU，挂起自动重启自愈机制。');
                    } else {
                        Logger.warn('ProxyDaemon', '触发强制自愈拉起...');
                        consecutiveRestarts++;
                        await SshService.restartShellCrashSecurely();
                        lastProxyRestartTime = Date.now();
                    }
                    consecutiveFailures = 0;
                }
                return false;
            }

            // 2. 检查代理端口是否健康监听
            if (!isPortListening) {
                hasIssue = true;
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/3] 检测到核心代理端口 ${config.ports.proxy} 假死/未开启`);
                if (consecutiveFailures >= 3 && Date.now() - lastProxyRestartTime > 300000) {
                    if (consecutiveRestarts >= 3) {
                        Logger.error('ProxyDaemon', '❌ 已经连续安全重启服务 3 次仍未恢复！挂起重启自愈以防止托死 CPU。');
                    } else {
                        Logger.warn('ProxyDaemon', '触发强制修复...');
                        consecutiveRestarts++;
                        await SshService.restartShellCrashSecurely();
                        lastProxyRestartTime = Date.now();
                    }
                    consecutiveFailures = 0;
                }
                return false;
            }

            // 2.5 检查重定向引流规则完整性
            if (hasProxyOrGame && redirectCount === 0) {
                hasIssue = true;
                Logger.warn('ProxyDaemon', '⚠️ 警告: 检测到 Clash 进程存活但 iptables 劫持规则被意外清空！正在自动执行引流重构修复...');
                try {
                    await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
                    Logger.info('ProxyDaemon', '✅ 官方引流规则已自愈重建');
                } catch (ruleErr) {
                    Logger.error('ProxyDaemon', '检测/重构防火墙引流规则失败', ruleErr);
                }
            }

            // 全量测速进行中时跳过代理连通性测试
            if (ClashService.isFullSpeedtestInProgress()) {
                Logger.debug('ProxyDaemon', '全量测速进行中，跳过代理连通性测试');
                return !hasIssue;
            }

            // 3. 检查海外代理链路可用性（NAS 本地 Axios，零 SSH 开销）
            const isProxyWorking = await this.testProxyConnectivity(config.ports.proxy, 'http://cp.cloudflare.com/generate_204', 4000);
            if (!isProxyWorking) {
                hasIssue = true;
                Logger.warn('ProxyDaemon', '⚠️ 检测到网页代理链路超时阻断！启动高并发自愈测速...');

                try {
                    const testGroupName = '⚡ 最快线路';
                    const proxiesData = await ClashService.getProxies();
                    const groupInfo = proxiesData && proxiesData.proxies ? proxiesData.proxies[testGroupName] : null;

                    if (groupInfo && groupInfo.all && groupInfo.all.length > 0) {
                        const targetNodes = groupInfo.all.slice(0, 5);
                        Logger.info('ProxyDaemon', `已自动识别到 [${testGroupName}] 下的 ${targetNodes.length} 个核心节点，开始串行测速自愈...`);

                        (async () => {
                            const results = [];
                            for (const node of targetNodes) {
                                try {
                                    const delay = await ClashService.testNodeDelay(node, 2000, 'http://www.gstatic.com/generate_204');
                                    Logger.debug('ProxyDaemon', `  节点 [${node}] 测速就绪: ${delay}ms`);
                                    results.push({ node, delay });
                                } catch (e) {
                                    results.push({ node, delay: 0 });
                                }
                            }
                            const activeCount = results.filter(r => r.delay > 0).length;
                            Logger.info('ProxyDaemon', `🎉 网页代理核心测速自愈串行完成，已成功激活并更新了 ${activeCount} 个可用节点的延迟历史！`);
                        })();
                    }
                } catch (gErr) {
                    Logger.error('ProxyDaemon', '并发最快线路自愈测速失败，转向后备方案', gErr);
                }

                let providerName = 'caomei1';
                try {
                    const providerOutput = await SshService.runRemoteCommand("grep -A 1 'proxy-providers:' /data/ShellCrash/config.yaml | tail -n 1 | cut -d: -f1 | tr -d ' '");
                    if (providerOutput && providerOutput.trim().length > 0 && !providerOutput.includes('Error')) {
                        providerName = providerOutput.trim();
                    }
                } catch (pErr) {}

                await this.triggerProviderHealthCheck(providerName);
                consecutiveFailures = 0;
                consecutiveRestarts = 0;
                lastProxyRestartTime = Date.now();
            } else {
                consecutiveFailures = 0;
                consecutiveRestarts = 0;
                Logger.debug('ProxyDaemon', '✅ 全部检测通过');
            }

            return !hasIssue;
        } catch (err) {
            Logger.error('ProxyDaemon', '自愈守护进程心跳检测发生异常（不计入进程故障次数，避免网络瞬间闪断引发误重启）', err);
            return false;
        }
    }

    // 涓流测速任务 (每 5 分钟测 1 个节点)
    static async runTrickleNodeCheck() {
        try {
            // 全量测速进行中时跳过涓流测速，避免并发测速压垮路由器
            if (ClashService.isFullSpeedtestInProgress()) {
                Logger.debug('ProxyDaemon', '[TrickleTest] 全量测速进行中，跳过本轮涓流测速');
                return;
            }
            // 如果列表空了或者游标走到底了，重新拉取最新节点列表
            if (trickleNodes.length === 0 || trickleIndex >= trickleNodes.length) {
                const proxiesData = await ClashService.getProxies();
                if (!proxiesData || !proxiesData.proxies) return;

                const testGroupName = '🚀 节点选择';
                const groupInfo = proxiesData.proxies[testGroupName];
                if (!groupInfo || !groupInfo.all || groupInfo.all.length === 0) {
                    Logger.debug('ProxyDaemon', `[TrickleTest] 未找到策略组 [${testGroupName}]`);
                    return;
                }

                // 过滤非物理节点
                trickleNodes = groupInfo.all.filter(nodeName => {
                    const lowerName = nodeName.toLowerCase();
                    return !['direct', 'global', 'rejection'].includes(lowerName) &&
                           !lowerName.includes('选择节点') &&
                           !lowerName.includes('节点选择');
                });
                trickleIndex = 0;
                
                if (trickleNodes.length > 0) {
                    Logger.info('ProxyDaemon', `[TrickleTest] 开启新一轮全节点涓流测速，共计 ${trickleNodes.length} 个节点 (预计耗时 ${trickleNodes.length} 分钟)`);
                }
            }

            if (trickleIndex < trickleNodes.length) {
                const nodeName = trickleNodes[trickleIndex];
                const delay = await ClashService.testNodeDelay(nodeName, 2000, 'http://www.gstatic.com/generate_204');
                Logger.debug('ProxyDaemon', `[TrickleTest] 节点测速完成: [${nodeName}] -> ${delay}ms (${trickleIndex + 1}/${trickleNodes.length})`);
                trickleIndex++;
            }
        } catch (err) {
            Logger.error('ProxyDaemon', '涓流测速任务发生异常', err);
        }
    }

    // 关闭监测器
    static stopProxyHealthMonitor() {
        if (proxyHealthStartTimeout) {
            clearTimeout(proxyHealthStartTimeout);
            proxyHealthStartTimeout = null;
        }
        if (proxyHealthMonitorTimer) {
            clearTimeout(proxyHealthMonitorTimer);
            proxyHealthMonitorTimer = null;
            Logger.info('ProxyDaemon', '⏹️ 网页代理健康度监测守护进程已关闭。');
        }
        if (trickleStartTimeout) {
            clearTimeout(trickleStartTimeout);
            trickleStartTimeout = null;
        }
        if (trickleTimer) {
            clearInterval(trickleTimer);
            trickleTimer = null;
            Logger.info('ProxyDaemon', '⏹️ 网页代理全节点涓流测速任务已注销。');
        }
    }
}

module.exports = ProxyHealthService;
