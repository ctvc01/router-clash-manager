const SshService = require('./sshService');
const ClashService = require('./clashService');
const Logger = require('../utils/logger');
const { config } = require('../config');

let proxyHealthMonitorTimer = null;
let proxyHealthStartTimeout = null; // 心跳启动延时器
let silentAllNodesTimer = null;     // 2小时静默测速定时器
let silentAllNodesStartTimeout = null; // 2小时静默测速启动延时器
let consecutiveFailures = 0;
let consecutiveRestarts = 0; // 连续重启计数器，防止级联雪崩

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

        // 1. 心跳检测：启动后延迟 180 秒（3分钟）正式激活，每 5 分钟轮询一次
        proxyHealthStartTimeout = setTimeout(() => {
            proxyHealthStartTimeout = null;
            Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测正式启动 (周期 5 分钟)');
            this._runHealthCheckScheduler();
        }, 180000);
        Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测已排程，将在 180 秒后错峰激活 (周期 5 分钟)');

        // 2. 网页代理全节点定时测速刷新任务：启动后延迟 15 分钟（900000ms）正式激活，每 2 小时（7200000ms）执行一次
        if (!silentAllNodesTimer && !silentAllNodesStartTimeout) {
            silentAllNodesStartTimeout = setTimeout(() => {
                silentAllNodesStartTimeout = null;
                Logger.info('ProxyDaemon', '🕰️ 网页代理全节点定时测速刷新任务正式启动 (周期 2 小时)');
                this.runSilentAllNodesCheck();

                silentAllNodesTimer = setInterval(() => {
                    this.runSilentAllNodesCheck();
                }, 7200000);
            }, 900000);
            Logger.info('ProxyDaemon', '🕰️ 网页代理全节点定时测速刷新已排程，将在 15 分钟后错峰激活 (周期 2 小时)');
        }
    }

    // 自适应调度器，保证单并发运行，防堆叠
    static async _runHealthCheckScheduler() {
        try {
            await this._runHealthCheck();
        } catch (e) {
            Logger.error('ProxyDaemon', '调度器捕获到未处理心跳异常', e);
        } finally {
            // 每次完全结束后，安排 5 分钟（300000 ms）后的下一次检测
            proxyHealthMonitorTimer = setTimeout(() => this._runHealthCheckScheduler(), 300000);
        }
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
            const pidOutput = await SshService.runRemoteCommand('pidof mihomo || pidof Clash || pidof CrashCore || pgrep -x mihomo || pgrep -x Clash || pgrep -x CrashCore');
            const isProcessRunning = pidOutput.trim().length > 0 && !pidOutput.includes('Error');

            if (!isProcessRunning) {
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/2] 检测到 Clash Core 进程已异常退出`);
                
                // 【极简优化 4】：获取路由器系统运行时间 (Uptime)，若刚开机不到 5 分钟，说明是整机重启导致服务未拉起，
                // 直接短路跳过 [2/2] 容错等待机制，一击必杀强制复活，将断网恢复期从 6 分钟压缩至数秒！
                let isJustBooted = false;
                try {
                    const uptimeStr = await SshService.runRemoteCommand("cat /proc/uptime | awk '{print $1}'");
                    const uptimeSec = parseFloat(uptimeStr);
                    if (!isNaN(uptimeSec) && uptimeSec < 300) {
                        isJustBooted = true;
                        Logger.warn('ProxyDaemon', `🚀 检测到路由器刚开机仅 ${Math.floor(uptimeSec)}s，跳过防抖等待，立即执行闪电自愈！`);
                    }
                } catch (e) {}

                if (consecutiveFailures >= 2 || isJustBooted) {
                    if (consecutiveRestarts >= 3) {
                        Logger.error('ProxyDaemon', '❌ 已经连续安全重启服务 3 次仍未恢复！疑似外网物理断开或订阅失效。为保护路由器 CPU，挂起自动重启自愈机制。');
                    } else {
                        Logger.warn('ProxyDaemon', '触发强制自愈拉起...');
                        consecutiveRestarts++;
                        await SshService.restartShellCrashSecurely();
                    }
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
                    if (consecutiveRestarts >= 3) {
                        Logger.error('ProxyDaemon', '❌ 已经连续安全重启服务 3 次仍未恢复！挂起重启自愈以防止拖死 CPU。');
                    } else {
                        Logger.warn('ProxyDaemon', '触发强制修复...');
                        consecutiveRestarts++;
                        await SshService.restartShellCrashSecurely();
                    }
                    consecutiveFailures = 0;
                }
                return;
            }

            // 2.5 检查重定向引流规则完整性（防御防火墙重置冲刷规则漏洞）
            try {
                const hasProxyOrGame = (await SshService.runRemoteCommand('[ -s /data/ShellCrash/configs/mac ] && echo 1 || echo 0')).trim() === '1';
                if (hasProxyOrGame) {
                    const redirectCount = parseInt(await SshService.runRemoteCommand('iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c REDIRECT || echo 0'), 10);
                    if (redirectCount === 0) {
                        Logger.warn('ProxyDaemon', '⚠️ 警告: 检测到 Clash 进程存活但 iptables 劫持规则被意外清空！正在自动执行引流重构修复...');
                        await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
                        Logger.info('ProxyDaemon', '✅ 官方引流规则已自愈重建');
                    }
                }
            } catch (ruleErr) {
                Logger.error('ProxyDaemon', '检测/重构防火墙引流规则失败', ruleErr);
            }

            // 3. 检查海外代理链路可用性
            const isProxyWorking = await this.testProxyConnectivity(config.ports.proxy, 'http://cp.cloudflare.com/generate_204', 4000);
            if (!isProxyWorking) {
                Logger.warn('ProxyDaemon', '⚠️ 检测到网页代理链路超时阻断！启动高并发自愈测速...');
                
                // 1) 优先方案：串行测速 ⚡ 最快线路 的前 5 个物理核心节点，驱动自动漂移自愈
                try {
                    const testGroupName = '⚡ 最快线路';
                    const proxiesData = await ClashService.getProxies();
                    const groupInfo = proxiesData && proxiesData.proxies ? proxiesData.proxies[testGroupName] : null;
                    
                    if (groupInfo && groupInfo.all && groupInfo.all.length > 0) {
                        // 仅挑选前 5 个主要物理高质节点进行测速刷新，减免路由器 CPU 负担
                        const targetNodes = groupInfo.all.slice(0, 5);
                        Logger.info('ProxyDaemon', `已自动识别到 [${testGroupName}] 下的 ${targetNodes.length} 个核心节点，开始串行测速自愈...`);
                        
                        // 在后台以串行排队方式执行（不阻塞主心跳检测线程）
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

                // 2) 后备方案：触发原有的 provider 重测自愈（如 caomei1 等）
                let providerName = 'caomei1';
                try {
                    const providerOutput = await SshService.runRemoteCommand("grep -A 1 'proxy-providers:' /data/ShellCrash/config.yaml | tail -n 1 | cut -d: -f1 | tr -d ' '");
                    if (providerOutput && providerOutput.trim().length > 0 && !providerOutput.includes('Error')) {
                        providerName = providerOutput.trim();
                    }
                } catch (pErr) {
                    // 忽略
                }
                await this.triggerProviderHealthCheck(providerName);
                consecutiveFailures = 0;
            } else {
                consecutiveFailures = 0;
                consecutiveRestarts = 0; // 成功连通时，重置连续重启计数器
                Logger.debug('ProxyDaemon', '✅ 全部检测通过');
            }
        } catch (err) {
            Logger.error('ProxyDaemon', '自愈守护进程心跳检测发生异常（不计入进程故障次数，避免网络瞬间闪断引发误重启）', err);
        }
    }

    // 定时全物理节点串行测速刷新任务 (每 2 小时一次)
    static async runSilentAllNodesCheck() {
        try {
            Logger.info('ProxyDaemon', '🕰️ 开始执行网页代理全物理节点定时测速刷新...');
            const proxiesData = await ClashService.getProxies();
            if (!proxiesData || !proxiesData.proxies) return;

            // 优先匹配主策略组
            const testGroupName = '🚀 节点选择';
            const groupInfo = proxiesData.proxies[testGroupName];
            if (!groupInfo || !groupInfo.all || groupInfo.all.length === 0) {
                Logger.warn('ProxyDaemon', `未找到策略组 [${testGroupName}]，跳过定时全节点刷新`);
                return;
            }

            // 过滤非物理节点
            const targetNodes = groupInfo.all.filter(nodeName => {
                const lowerName = nodeName.toLowerCase();
                return !['direct', 'global', 'rejection'].includes(lowerName) &&
                       !lowerName.includes('选择节点') &&
                       !lowerName.includes('节点选择');
            });

            Logger.info('ProxyDaemon', `获取到 ${targetNodes.length} 个网页备选物理节点，开始全量串行测速...`);
            
            // 串行测试所有节点，指定超时为 2000ms
            let activeCount = 0;
            for (const node of targetNodes) {
                const delay = await ClashService.testNodeDelay(node, 2000, 'http://www.gstatic.com/generate_204');
                if (delay > 0) {
                    activeCount++;
                }
                // 【极简优化 5】：全量扫盘必定拉高弱鸡路由器 CPU 并挤占文件描述符，每次测完强制睡眠 1000ms 缓冲降压
                await new Promise(r => setTimeout(r, 1000));
            }

            Logger.info('ProxyDaemon', `🎉 网页代理全节点定时测速刷新完成，共 ${activeCount}/${targetNodes.length} 个可用节点延迟已更新历史。`);
        } catch (err) {
            Logger.error('ProxyDaemon', '网页代理全节点定时测速任务发生异常', err);
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
        if (silentAllNodesStartTimeout) {
            clearTimeout(silentAllNodesStartTimeout);
            silentAllNodesStartTimeout = null;
        }
        if (silentAllNodesTimer) {
            clearInterval(silentAllNodesTimer);
            silentAllNodesTimer = null;
            Logger.info('ProxyDaemon', '⏹️ 网页代理全节点定时测速刷新任务已注销。');
        }
    }
}

module.exports = ProxyHealthService;
