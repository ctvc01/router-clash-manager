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
let _lastHeartbeatTime = 0; // 心跳看门狗最近一次成功时间戳
let _heartbeatWatchdogTimer = null; // 心跳看门狗定时器
let _lastMaintenanceDay = 0; // 3AM 维护重启标记（按日期）
let consecutiveFailures = 0;
let consecutiveRestarts = 0; // 连续重启计数器，防止级联雪崩
let lastProxyRestartTime = 0; // 本地追踪最近重启时间（不依赖 SshService）
let lastDeepCheckTime = 0;   // 最近一次深度 SSH 诊断时间
let lastTier1FailAt = 0;     // 最近一次 Tier1 HTTP 失败时间戳（用于温柔重试）
let tier1Pending = false;    // 上一轮 Tier1 首次失败进入宽限期，调度器需强制 30s 复测

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

    // [新增] WebHook 紧急触发自愈拉起接口
    static async triggerEmergencyHealing() {
        Logger.warn('ProxyDaemon', '⚡ WebHook 触发紧急自愈流程，重置计数器并调用 restartShellCrashSecurely...');
        consecutiveFailures = 0;
        consecutiveRestarts = 0; // 重置防抖计数器，确保这次自愈肯定能执行
        await SshService.restartShellCrashSecurely();
        lastProxyRestartTime = Date.now();
    }

    // 启动代理模式全局健康自愈监测器 (错峰调度与定时全节点检测)
    static startProxyHealthMonitor() {
        if (proxyHealthMonitorTimer || proxyHealthStartTimeout) return;

        Logger.info('ProxyDaemon', '🛡️ 网页代理全局健康度自愈监测守护进程排程中...');
        consecutiveFailures = 0;

        // 1. 心跳检测：启动后延迟 180 秒（3分钟）正式激活，健康时每 10 分钟做一次 HTTP Ping，异常时 30s 快速重检
        proxyHealthStartTimeout = setTimeout(() => {
            proxyHealthStartTimeout = null;
            Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测正式启动 (健康 10min / 异常 30s)');
            this._runHealthCheckScheduler();
        }, 180000);
        Logger.info('ProxyDaemon', '🛡️ 网页代理心跳监测已排程，将在 180 秒后错峰激活 (健康 10min / 异常 30s)');

        // 2. 心跳链看门狗：每 5 分钟检查一次心跳是否停滞（超过 15 分钟无更新），
        // 如果心跳链断裂，自动重启调度器
        if (_heartbeatWatchdogTimer === null) {
            _heartbeatWatchdogTimer = setInterval(() => {
                const elapsed = Date.now() - _lastHeartbeatTime;
                if (_lastHeartbeatTime > 0 && elapsed > 900000) {
                    Logger.warn('ProxyDaemon', '心跳链看门狗探测到心跳停滞超过 15 分钟，正在重启调度器...');
                    if (proxyHealthMonitorTimer) {
                        clearTimeout(proxyHealthMonitorTimer);
                        proxyHealthMonitorTimer = null;
                    }
                    this._runHealthCheckScheduler();
                    _lastHeartbeatTime = Date.now();
                }
            }, 300000);
        }
    }

   // 自适应心跳调度器：健康时 10min HTTP 探活，异常/连续故障时 30s 快速重检；连续重启挂起时也拉长到 10min 保护路由器
   static async _runHealthCheckScheduler() {
        const startTime = Date.now();
        try {
            const isHealthy = await this._runHealthCheck();
            const elapsed = Date.now() - startTime;

            // 健康：10 分钟一次 HTTP Ping
            // 异常（consecutiveFailures>0）：30 秒快速重检
            // 挂起（consecutiveRestarts>=3）：强制拉长 10 分钟，避免继续压
            let nextInterval;

            // 3AM 维护重启：北京时间凌晨 3:00-3:05 执行一次主动冷重启（non-轻量，完整重启）
            const { hour } = require('../constants').getBeijingTimeParts();
            const today = new Date().getDate();
            if (hour === 3 && today !== _lastMaintenanceDay) {
                _lastMaintenanceDay = today;
                Logger.info('ProxyDaemon', '北京时间 3:00，执行例行主动冷重启维护...');
                await SshService.restartShellCrashSecurely();
                lastProxyRestartTime = Date.now();
                consecutiveFailures = 0;
                consecutiveRestarts = 0;
                nextInterval = 600000;
                proxyHealthMonitorTimer = setTimeout(() => this._runHealthCheckScheduler(), nextInterval);
                return;
            }

            if (consecutiveRestarts >= 3) {
                nextInterval = 600000;
            } else if (!isHealthy || consecutiveFailures > 0 || tier1Pending) {
                nextInterval = 30000;
                // 如果是 ECONNREFUSED（路由器确定不可达），延长到60s
                if (lastTier1FailAt > 0 && Date.now() - lastTier1FailAt > 90000) {
                    nextInterval = 60000;
                }
            } else {
                nextInterval = 600000;
            }

            _lastHeartbeatTime = Date.now();
            Logger.debug('ProxyDaemon', `心跳检测完成 (${elapsed}ms) ${isHealthy ? '✅ 健康' : '⚠️ 异常'}，下一次检测在 ${nextInterval / 1000}s 后`);
            proxyHealthMonitorTimer = setTimeout(() => this._runHealthCheckScheduler(), nextInterval);
        } catch (e) {
            Logger.error('ProxyDaemon', '调度器捕获到未处理心跳异常', e);
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

            // ⚡ Tier 1: 快速 HTTP 接口存活度测试（Clash /version），零 SSH 开销
            //   - 超时（timeout）：视为瞬闪，首次仅记录时间戳并要求 30s 复测；连续两次（≤90s）才升级 Tier 2 SSH
            //   - ECONNREFUSED：确定性故障（进程/端口已死），立即升级 Tier 2，不给宽限
            let tier1Ok = false;
            try {
                const version = await ClashService.getVersion(3000);
                if (version && version.version) {
                    tier1Ok = true;
                    lastTier1FailAt = 0; // 探活成功，清理失败标记
                    tier1Pending = false;
                }
            } catch (httpErr) {
                const msg = httpErr && httpErr.message ? httpErr.message : String(httpErr);
                const isRefused = /ECONNREFUSED/i.test(msg) || httpErr.code === 'ECONNREFUSED';
                if (isRefused) {
                    Logger.warn('ProxyDaemon', `Tier 1 HTTP ECONNREFUSED — 代理端口已死，立即升级 Tier 2 SSH`);
                    lastTier1FailAt = 0;
                    tier1Pending = false;
                    // fall through 到 Tier 2 深度诊断
                } else {
                    const now = Date.now();
                    const gap = now - lastTier1FailAt;
                    if (lastTier1FailAt === 0 || gap > 90000) {
                        // 首次或距上次失败已超 90s：视为瞬闪，仅记录时间，强制 30s 复测
                        lastTier1FailAt = now;
                        tier1Pending = true;
                        Logger.warn('ProxyDaemon', `Tier 1 HTTP 超时首次失败 (${msg})，30s 后复测，暂不升级 SSH`);
                        return true; // 视作健康，等下轮（调度器会读 tier1Pending 强制 30s）
                    }
                    Logger.warn('ProxyDaemon', `Tier 1 HTTP 连续超时 (${msg}, 距上次 ${Math.floor(gap/1000)}s)，升级 Tier 2 SSH`);
                    lastTier1FailAt = 0;
                    tier1Pending = false;
                }
            }
            if (tier1Ok) {
                // 长期健康：允许 consecutiveRestarts 计数器自然清零，避免历史故障永久压制自愈
                if (consecutiveRestarts > 0 && Date.now() - lastProxyRestartTime > 30 * 60 * 1000) {
                    Logger.info('ProxyDaemon', '连续 30 分钟健康，重启计数器自动清零');
                    consecutiveRestarts = 0;
                }
                return true;
            }

            // ⚡ Tier 2: 深度 SSH 诊断
            lastDeepCheckTime = Date.now();
            let hasIssue = false; // 跟踪是否有任何异常

            // === [BATCH QUERY] 一次 SSH 查询获取 6 项关键状态并进行内存释放自愈（防 dropbear 风暴及 OOM） ===
            const batchCmd = [
                `echo "BATCH_START"`,
                `echo "PID:$(pidof mihomo 2>/dev/null || pidof Clash 2>/dev/null || pidof CrashCore 2>/dev/null || pgrep -x mihomo 2>/dev/null || pgrep -x Clash 2>/dev/null || pgrep -x CrashCore 2>/dev/null || echo 'no_pid')"`,
                `echo "PORT:$(netstat -nlt 2>/dev/null | grep -q ':${config.ports.proxy}' && echo ok || echo down)"`,
                `echo "MAC:$([ -s /data/ShellCrash/configs/mac ] && echo yes || echo no)"`,
                `echo "IPT:$(iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c REDIRECT || echo 0)"`,
                `echo "UPTIME:$(cat /proc/uptime 2>/dev/null | awk '{print \$1}' || echo 0)"`,
                `FREE_MEM=\$(awk '/MemFree:/ {print \$2}' /proc/meminfo 2>/dev/null || echo 0)`,
                `[ \$FREE_MEM -gt 0 ] && [ \$FREE_MEM -lt 30000 ] && (sync; echo 3 > /proc/sys/vm/drop_caches; echo "MEM_CLEAN:done") || echo "MEM_CLEAN:skip"`,
                `echo "VMRSS:$(awk '/VmRSS:/ {print $2}' /proc/$(pidof mihomo 2>/dev/null || pidof Clash 2>/dev/null)/status 2>/dev/null || echo 0)"`,
                `echo "MEMAVAIL:$(awk '/MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"`,
                `echo "BATCH_END"`
            ].join('; ');

            const batchOutput = await SshService.runRemoteCommand(batchCmd);
            const outputStr = String(batchOutput || '');
            let pid = '', portStatus = '', macStatus = '', redirectCount = 0, uptimeVal = 0, memCleanStatus = '', memAvailable = 0, vmRss = 0;
            try {
                const batchLines = outputStr.split('\n').map(l => l.trim()).filter(l => l);
                const batchStart = batchLines.findIndex(l => l.includes('BATCH_START'));
                const batchEnd = batchLines.findIndex(l => l.includes('BATCH_END'));

                if (batchStart >= 0 && batchEnd > batchStart) {
                    const dataLines = batchLines.slice(batchStart + 1, batchEnd);
                    for (const dl of dataLines) {
                        if (dl.startsWith('PID:')) pid = dl.slice(4).trim();
                        else if (dl.startsWith('PORT:')) portStatus = dl.slice(5).trim();
                        else if (dl.startsWith('MAC:')) macStatus = dl.slice(4).trim();
                        else if (dl.startsWith('IPT:')) redirectCount = parseInt(dl.slice(4).trim(), 10) || 0;
                        else if (dl.startsWith('UPTIME:')) uptimeVal = parseFloat(dl.slice(7).trim()) || 0;
                        else if (dl.startsWith('MEM_CLEAN:')) memCleanStatus = dl.slice(10).trim();
                    else if (dl.startsWith('MEMAVAIL:')) memAvailable = parseInt(dl.slice(9).trim(), 10) || 0;
                    else if (dl.startsWith('VMRSS:')) vmRss = parseInt(dl.slice(6).trim(), 10) || 0;
                    }
                }
            } catch (parseErr) {
                Logger.warn('ProxyDaemon', '批量 SSH 输出解析失败，跳过', { error: parseErr.message, output: outputStr.slice(0, 200) });
            }

            if (memCleanStatus === 'done') {
                Logger.info('ProxyDaemon', '🧹 监测到路由器可用内存低于 30MB 临界值，已成功执行 sync 与内存缓存自动释放自愈！');
            }


            // 内存守卫：检查 MemAvailable 和 mihomo VmRSS，超过阈值则触发轻量冷重启
            if (memAvailable > 0 && memAvailable < 80000) {
                Logger.warn('ProxyDaemon', '路由器可用内存 (MemAvailable) 低于 80MB（当前 ' + memAvailable + 'KB），触发轻量冷重启释放内存...');
                await SshService.quickRestartShellCrash();
                lastProxyRestartTime = Date.now();
                consecutiveFailures = 0;
                return false;
            }
            if (vmRss > 0 && vmRss > 200000) {
                Logger.warn('ProxyDaemon', 'mihomo VmRSS 超过 200MB（当前 ' + (vmRss / 1000).toFixed(1) + 'MB），触发轻量冷重启释放内存...');
                await SshService.quickRestartShellCrash();
                lastProxyRestartTime = Date.now();
                consecutiveFailures = 0;
                return false;
            }

            const isProcessRunning = pid && pid.length > 0 && pid !== 'no_pid' && !pid.includes('Error');
            const isPortListening = portStatus === 'ok';
            const hasProxyOrGame = macStatus === 'yes';

            // 1. 检查 Clash Core 进程
            if (!isProcessRunning) {
                hasIssue = true;
                consecutiveFailures++;
                Logger.warn('ProxyDaemon', `⚠️ [${consecutiveFailures}/2] 检测到 Clash Core 进程已异常退出`);

                let isJustBooted = false;
                if (uptimeVal > 0 && uptimeVal < 600) {
                    isJustBooted = true;
                    Logger.warn('ProxyDaemon', `🚀 检测到路由器刚开机仅 ${Math.floor(uptimeVal)}s，跳过防抖等待，立即执行闪电自愈！`);
                }

                // 核心进程挂掉是特级故障，冷却时间缩短为 30 秒（而非 5 分钟），确保断网后第一时间内快速自愈拉起
                if ((consecutiveFailures >= 2 || isJustBooted) && Date.now() - lastProxyRestartTime > 30000) {
                    if (consecutiveRestarts >= 3) {
                        Logger.error('ProxyDaemon', '❌ 已经连续安全重启服务 3 次仍未恢复！疑似外网物理断开或订阅失效。为保护路由器 CPU，挂起自动重启自愈机制。');
                    } else {
                        Logger.warn('ProxyDaemon', '⚡ 核心进程失联，立即触发强制自愈拉起...');
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

            // 3. 检查海外代理链路可用性（NAS 本地 Axios，零 SSH 开销）
            const isProxyWorking = await this.testProxyConnectivity(config.ports.proxy, 'http://cp.cloudflare.com/generate_204', 4000);
            if (!isProxyWorking) {
                hasIssue = true;
                Logger.warn('ProxyDaemon', '⚠️ 检测到网页代理出海链路超时阻断！已将异常回显，请在详情弹窗中手动测速或手动切换。');
                consecutiveFailures = 0;
                consecutiveRestarts = 0;
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

    // 手动触发网页代理全节点串行测速 (防负载高)
    static async runManualProxySpeedtest() {
        Logger.info('ProxyDaemon', '⚡ 手动触发网页代理全节点串行测速开始...');
        const ClashService = require('./clashService');
        const SpeedtestState = require('./speedtestState');
        
        ClashService.setFullSpeedtestFlag(true);
        try {
            const proxiesData = await ClashService.getProxies();
            if (!proxiesData || !proxiesData.proxies) return;

            const testGroupName = '🚀 节点选择';
            const groupInfo = proxiesData.proxies[testGroupName];
            if (!groupInfo || !groupInfo.all || groupInfo.all.length === 0) {
                Logger.warn('ProxyDaemon', `[ManualTest] 未找到策略组 [${testGroupName}]`);
                return;
            }

            // 过滤非物理节点
            const targetNodes = groupInfo.all.filter(nodeName => {
                const lowerName = nodeName.toLowerCase();
                return !['direct', 'global', 'rejection', 'compatible'].includes(lowerName) &&
                       !lowerName.includes('选择节点') &&
                       !lowerName.includes('节点选择') &&
                       !lowerName.includes('自动测速') &&
                       !lowerName.includes('最快线路');
            });

            if (targetNodes.length === 0) {
                Logger.warn('ProxyDaemon', '[ManualTest] 过滤后网页代理无可用物理子节点');
                return;
            }

            Logger.info('ProxyDaemon', `[ManualTest] 准备对 ${targetNodes.length} 个网页代理物理节点进行串行测速...`);

            let bestNode = null;
            let minDelay = 99999;
            const results = [];

            for (let i = 0; i < targetNodes.length; i++) {
                const nodeName = targetNodes[i];
                try {
                    // 使用 http://www.gstatic.com/generate_204 测试
                    const delay = await ClashService.testNodeDelay(nodeName, 2000, 'http://www.gstatic.com/generate_204');
                    Logger.debug('ProxyDaemon', `[ManualTest] [${i+1}/${targetNodes.length}] ${nodeName}: ${delay}ms`);
                    if (delay > 0) {
                        results.push({ name: nodeName, delay });
                        if (delay < minDelay) {
                            minDelay = delay;
                            bestNode = nodeName;
                        }
                    } else {
                        results.push({ name: nodeName, delay: -1 });
                    }
                } catch (e) {
                    results.push({ name: nodeName, delay: -1 });
                }
                // 串行测速中加一个小小的 50ms 避让，防止路由器 CPU 持续跑满
                await new Promise(r => setTimeout(r, 50));
            }

            if (bestNode) {
                Logger.info('ProxyDaemon', `🎉 [ManualTest] 网页代理串行测速完成！最快节点: [${bestNode}] (${minDelay}ms)`);
                SpeedtestState.updateResult('proxy', { name: bestNode, delay: minDelay });
            } else {
                Logger.warn('ProxyDaemon', '[ManualTest] 网页代理所有物理节点均测速超时！');
                SpeedtestState.updateResult('proxy', { name: '全部超时', delay: -1 });
            }
        } catch (err) {
            Logger.error('ProxyDaemon', '手动代理测速过程异常', err);
        } finally {
            ClashService.setFullSpeedtestFlag(false);
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
        if (_heartbeatWatchdogTimer) {
            clearInterval(_heartbeatWatchdogTimer);
            _heartbeatWatchdogTimer = null;
        }
    }
}

module.exports = ProxyHealthService;
