const { execFile } = require('child_process');
const { config } = require('../config');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');
const ClashService = require('./clashService');
const fs = require('fs');
const path = require('path');

let restartPromise = Promise.resolve();
let lastRestartTime = 0;

let routerHealthCache = null; // { at, data:{ uptime, load1, ok } }
// 通用超时包装：给串行队列上的 promise 强加 wall-clock 上限，
// 避免任何一次 hang 永久堵死后续排队请求（保护自愈机制不被自身阻塞）
function withHardTimeout(promise, ms, tag) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} 超过 ${ms}ms 硬超时`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

class SshService {
    // 清洗 SSH/expect 命令流的多余系统数据干扰
    static _cleanOutput(stdout) {
        if (!stdout) return '';
        return stdout.split('\n')
            .filter(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('spawn ssh')) return false;
                if (trimmed.includes('password:')) return false;
                if (trimmed.startsWith('**')) return false;
                if (trimmed.includes('post-quantum')) return false;
                if (trimmed.includes('vulnerable to')) return false;
                if (trimmed.includes('openssh.com')) return false;
                if (trimmed.startsWith('Warning:')) return false;
                return true;
            })
            .join('\n')
            .trim();
    }

    // 执行远程命令（带自动重试）
    static runRemoteCommand(command, maxRetries = 2) {
        return this._executeWithRetry(command, 0, maxRetries);
    }

    // 内部实现：带指数退避的命令执行
    static _executeWithRetry(command, attempt = 0, maxRetries = 2) {
        return new Promise((resolve, reject) => {
            try {
                // 安全审计：命令校验
                Validators.validateSSHCommand(command);
            } catch (validationErr) {
                Logger.error('SSH', `命令拦截异常: ${validationErr.message}`);
                return reject(validationErr);
            }

            const sshExecPath = config.paths.sshExec;

            // 使用 execFile 避免本地 shell 注入；15s 硬 wall-clock 超时兜底，
            // 防止路由器过载导致 SSH 命令永久挂起并锁死上游串行队列
            const SSH_HARD_TIMEOUT_MS = 15000;
            execFile(sshExecPath, [command], { timeout: SSH_HARD_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
                if (error) {
                    // 特例：如果是 pgrep 命令返回 1（说明进程不存在），这在 Shell 语法中代表未匹配，应正常处理
                    if (command.includes('pgrep') && error.code === 1) {
                        return resolve('');
                    }

                    // 关键区分：
                    // 1) "Operation timed out" / ETIMEDOUT —— 路由器已过载或不可达，重试只会雪上加霜，最多 1 次快速重试
                    // 2) 短暂的连接重置/kex 失败 —— Dropbear 并发压力，可温和重试 2 次
                    const stderrStr = stderr || '';
                    const stdoutStr = stdout || '';
                    const combined = stderrStr + stdoutStr;

                    // Node execFile 命中 timeout 会 kill 子进程并设置 error.killed=true, signal=SIGKILL
                    const isHardTimeout = error.killed === true && (error.signal === 'SIGKILL' || error.signal === 'SIGTERM');
                    const isTimeout = isHardTimeout ||
                                     error.code === 'ETIMEDOUT' ||
                                     combined.includes('Operation timed out') ||
                                     combined.includes('Connection timed out') ||
                                     combined.includes('Connection timeout');
                    const isTransient = combined.includes('Connection refused') ||
                                       combined.includes('Connection reset') ||
                                       combined.includes('Connection closed') ||
                                       combined.includes('kex_exchange_identification');
                    const isRetryable = isTimeout || isTransient ||
                                       error.code === 'ECONNREFUSED' ||
                                       error.code === 'EHOSTUNREACH' ||
                                       error.code === 255;

                    // 超时类：最多 1 次快速重试（200ms）
                    // 瞬态类：最多 maxRetries 次退避重试（200/800ms）
                    const effectiveMax = isTimeout ? Math.min(1, maxRetries) : maxRetries;

                    if (isRetryable && attempt < effectiveMax) {
                        const delay = isTimeout ? 200 : (attempt === 0 ? 200 : 800);
                        Logger.debug('SSH', `命令执行失败(${isHardTimeout ? 'hard-timeout' : (isTimeout ? 'timeout' : 'transient')})，${delay}ms后重试 (${attempt + 1}/${effectiveMax})`);
                        setTimeout(() => {
                            this._executeWithRetry(command, attempt + 1, maxRetries).then(resolve).catch(reject);
                        }, delay);
                    } else {
                        if (isHardTimeout) {
                            Logger.error('SSH', `命令被 15s 硬超时终止 (attempt=${attempt + 1}): "${command.slice(0, 120)}"`);
                        } else {
                            Logger.error('SSH', `远程命令执行失败 (已重试${attempt}次): "${command}"`, { error, stderr, stdout });
                        }
                        reject({ error, stdout, stderr, attempts: attempt + 1 });
                    }
                } else {
                    const cleaned = this._cleanOutput(stdout);
                    resolve(cleaned);
                }
            });
        });
    }


    // 上传容器本地文件到路由器（通过 scp_to_remote.exp 脚本，30秒超时保护）
    static uploadFileLocal(localPath, remotePath) {
        return new Promise((resolve, reject) => {
            const scpScript = config.paths.sshExec.replace('ssh_wrapper.sh', 'scp_to_remote.exp');
            const env = {
                ...process.env,
                ROUTER_IP: config.router.ip,
                ROUTER_USER: config.router.user,
                ROUTER_PASSWORD: config.router.password
            };
            execFile(scpScript, [localPath, remotePath], { env, timeout: 30000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
                if (error) {
                    Logger.error('SSH', `文件上传失败: ${localPath} -> ${remotePath}`, { error, stderr });
                    reject(error);
                } else {
                    Logger.info('SSH', `文件上传成功: ${localPath} -> ${remotePath}`);
                    resolve();
                }
            });
        });
    }

    // 上传最新的安全防火墙引流脚本到路由器并赋权，同时推送 AI 白名单
    static async pushIptablesScript() {
        try {
            const localIptablesScript = path.join(__dirname, '..', '..', 'scripts', 'setup_iptables.sh');
            const localGuardScript = path.join(__dirname, '..', '..', 'scripts', 'guard_iptables.sh');
            
            if (fs.existsSync(localIptablesScript)) {
                Logger.info('ShellCrash', '正在上传最新安全引流脚本 setup_iptables.sh 至路由器...');
                await this.uploadFileLocal(localIptablesScript, '/data/ShellCrash/setup_iptables.sh');
                await this.runRemoteCommand('chmod +x /data/ShellCrash/setup_iptables.sh');
                
                // 同步推送 AI 设备白名单
                const aiDevicesPath = require('../config').config.paths.aiDevices;
                if (fs.existsSync(aiDevicesPath)) {
                    await this.uploadFileLocal(aiDevicesPath, '/data/ShellCrash/configs/ai_devices');
                }
                
                // [新增] 同步推送防火墙联动降级守护脚本并后台启动
                if (fs.existsSync(localGuardScript)) {
                    Logger.info('ShellCrash', '正在上传最新防火墙守护脚本 guard_iptables.sh 至路由器...');
                    await this.uploadFileLocal(localGuardScript, '/data/ShellCrash/guard_iptables.sh');
                    await this.runRemoteCommand('chmod +x /data/ShellCrash/guard_iptables.sh');
                    
                    // 启动后台巡检死循环，如果已经在运行则跳过，防止重复启动
                    await this.runRemoteCommand('pgrep -f "guard_iptables.sh" >/dev/null || ( /data/ShellCrash/guard_iptables.sh </dev/null >/dev/null 2>&1 & )');
                    Logger.info('ShellCrash', '防火墙守护脚本已成功推送并确保后台挂起运行');
                }
                
                
                Logger.info('ShellCrash', '安全引流脚本及依赖配置推送成功');
            } else {
                Logger.warn('ShellCrash', `本地未找到安全引流脚本: ${localIptablesScript}，跳过推送`);
            }
        } catch (err) {
            Logger.error('ShellCrash', '推送最新防火墙引流脚本失败', err);
            throw err;
        }
    }

    // 确保 iptables 规则存在（路由器重启后恢复）
    static async ensureIptablesRules() {
        try {
            await this.pushIptablesScript();
            await this.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
            const ruleCount = await this.runRemoteCommand('iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c "redir ports 7892" || echo 0');
            Logger.info('ShellCrash', `iptables 规则已初始化 (${ruleCount.trim()} 条 TCP REDIRECT)`);
        } catch (err) {
            Logger.warn('ShellCrash', 'iptables 规则初始化失败', err);
            throw err;
        }
    }

    // 优先使用平滑热重载，失败后自动降级为安全冷重启
    static async reloadShellCrashSecurely(configPath = '/data/ShellCrash/config.yaml') {
        Logger.info('ShellCrash', `尝试执行平滑热重载配置: ${configPath}`);
        const success = await ClashService.hotReloadConfig(configPath);
        if (success) {
            // 热重载成功后，仅需等待极短时间让内核完成内部路由树重建
            await new Promise(r => setTimeout(r, 1000));
            Logger.info('ShellCrash', '✅ 平滑热重载完成，网络连接未中断。');
            return true;
        } else {
            Logger.warn('ShellCrash', '⚠️ 平滑热重载失败，等待 2秒 确认内核状态后再决定是否冷重启...');
            // 给 Clash 内核 2 秒 settle 时间，避免因短暂 API 不可达而误判崩溃
            await new Promise(r => setTimeout(r, 2000));
            // 再次检查 Clash 是否真的挂了
            try {
                const versionCheck = await ClashService.getVersion(5000);
                if (versionCheck && versionCheck.version) {
                    Logger.info('ShellCrash', 'Clash 内核仍在运行，跳过冷重启（热重载可能因超时或不兼容而静默失败，但配置已被 rulesEngine 写入）。');
                    // 热重载成功场景下也要更新 restarTimes，让 ProxyDaemon 冷却期生效
                    SshService.updateLastRestartTime && SshService.updateLastRestartTime();
                    return false;
                }
            } catch (e) { /* 确实挂了，继续降级冷重启 */ }
            Logger.warn('ShellCrash', '确认 Clash 内核无响应，降级执行冷重启...');
            await this.restartShellCrashSecurely();
            return false;
        }
    }

    // 轻量冷重启：仅 killall -> start -> waitPort，无 iptables/备份/内核检查
    // 用于内存不足等场景的快速自愈，3-5s 断网时间，代替完整冷重启的 15-20s
    static async quickRestartShellCrash() {
        const LIGHT_RESTART_HARD_TIMEOUT_MS = 120000;
        const chained = restartPromise.then(async () => {
            // 30s 重启间隔守卫：防止连续调度导致重启风暴
            if (lastRestartTime > 0 && Date.now() - lastRestartTime < 30000) {
                Logger.info('ShellCrash', `上次重启仅 ${Math.round((Date.now() - lastRestartTime)/1000)}s 前，跳过本轮轻量冷重启（最小间隔 30s）`);
                return;
            }
            try {
                Logger.info('ShellCrash', '正在执行轻量冷重启 (killall -> start -> waitPort)...');
                await this.runRemoteCommand('killall mihomo Clash 2>/dev/null; true');
                for (let i = 0; i < 5; i++) {
                    const pidOut = await this.runRemoteCommand('pidof mihomo || pidof Clash 2>/dev/null || echo ""');
                    if (!pidOut.trim()) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                await this.runRemoteCommand('( /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null & )');
                const apiReady = await ClashService.waitClashReady(15);
                if (apiReady) {
                    Logger.info('ShellCrash', '轻量冷重启完成，API 已就绪。');
                } else {
                    Logger.warn('ShellCrash', '轻量冷重启后 Clash API 在 15s 内未就绪，但进程已启动。');
                }
                lastRestartTime = Date.now();
            } catch (err) {
                const stderrMsg = err.stderr || '';
                const errMsg = (err.error && err.error.message) || '';
                const isClosedByRemote = stderrMsg.includes('closed by remote') ||
                                         errMsg.includes('closed by remote') ||
                                         stderrMsg.includes('Connection') ||
                                         errMsg.includes('Connection') ||
                                         stderrMsg.includes('kex_exchange_identification') ||
                                         errMsg.includes('kex_exchange_identification') ||
                                         (err.error && err.error.code === 255);
                if (isClosedByRemote) {
                    Logger.info('ShellCrash', '轻量冷重启中 SSH 断开（网络重构正常现象），已安全忽略。');
                    return;
                }
                Logger.error('ShellCrash', '轻量冷重启异常', err);
                throw new Error('轻量冷重启失败: ' + (stderrMsg || errMsg));
            }
        });
        restartPromise = withHardTimeout(chained, LIGHT_RESTART_HARD_TIMEOUT_MS, 'quickRestartShellCrash').catch(err => {
            Logger.error('ShellCrash', '轻量冷重启链路熔断：' + err.message + '，自复位以便后续可继续排队');
        });
        return chained;
    }

    // 安全重启 ShellCrash，带串行排队锁和正确的启动等待逻辑
    // 读取路由器健康快照（uptime + loadavg-1min），单次 SSH 完成，30s TTL 缓存
    // 供静默测速等长任务在启动前预检，避免在路由器刚开机或高负载窗口继续压
    static async getRouterHealthSnapshot(maxAgeMs = 30000) {
        const now = Date.now();
        if (routerHealthCache && (now - routerHealthCache.at) < maxAgeMs) {
            return routerHealthCache.data;
        }
        try {
            const raw = await this.runRemoteCommand(
                `echo "UPTIME:$(awk '{print $1}' /proc/uptime 2>/dev/null || echo 0)"; echo "LOAD1:$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"`
            );
            let uptime = 0, load1 = 0;
            String(raw || '').split(/\r?\n/).forEach(line => {
                const l = line.trim();
                if (l.startsWith('UPTIME:')) uptime = parseFloat(l.slice(7)) || 0;
                else if (l.startsWith('LOAD1:')) load1 = parseFloat(l.slice(6)) || 0;
            });
            const data = { uptime, load1, ok: uptime > 0 };
            routerHealthCache = { at: now, data };
            return data;
        } catch (err) {
            Logger.debug('SSH', `getRouterHealthSnapshot 失败: ${err.message || err}`);
            const data = { uptime: 0, load1: 0, ok: false };
            routerHealthCache = { at: now, data };
            return data;
        }
    }

    static async restartShellCrashSecurely() {
        // 用 hard-timeout 包装本次重启任务（含队列等待），失败/超时后自复位 restartPromise
        // 防止某次重启 hang 住导致后续所有自愈请求排队至死
        const RESTART_HARD_TIMEOUT_MS = 300000; // 5 分钟
        const chained = restartPromise.then(async () => {
            // 30s 重启间隔守卫：防止连续调度导致重启风暴
            if (lastRestartTime > 0 && Date.now() - lastRestartTime < 30000) {
                Logger.info('ShellCrash', `上次重启仅 ${Math.round((Date.now() - lastRestartTime)/1000)}s 前，跳过本轮冷重启（最小间隔 30s）`);
                return;
            }
            try {
                Logger.info('ShellCrash', '正在请求重启 ShellCrash 服务 (排队中)...');

                // 0. 清除启动锁定文件（确保不会因旧失败状态锁定）
                await this.runRemoteCommand('rm -f /data/ShellCrash/.start_error');
                Logger.info('ShellCrash', '已清除启动错误标记文件');

                // 0a. 路由器重启后自动补全内核与地理数据库 (本地Gzip冷备极速自愈 + 网络上传兜底)
                const isKernelExist = await this.runRemoteCommand('[ -f /tmp/ShellCrash/mihomo ] && echo 1 || echo 0');
                if (isKernelExist.trim() !== '1') {
                    Logger.warn('ShellCrash', '⚠️ 探测到路由器重启导致 /tmp 内核丢失，尝试本地冷备解压自愈...');
                    await this.runRemoteCommand('mkdir -p /tmp/ShellCrash');
                    
                    // 优先尝试从路由器本地 /data/ShellCrash/mihomo.bak 闪存的 gzip 备份包进行解压恢复
                    const localRestoreResult = await this.runRemoteCommand(
                        'if [ -f /data/ShellCrash/mihomo.bak ]; then ' +
                        'gzip -d -c /data/ShellCrash/mihomo.bak > /tmp/ShellCrash/mihomo && chmod +x /tmp/ShellCrash/mihomo && echo 1 || echo 0; ' +
                        'else echo 0; fi'
                    );
                    
                    if (localRestoreResult.trim() === '1') {
                        Logger.info('ShellCrash', '✅ 成功从路由器本地闪存 /data 极速解压 Gzip 内核，微秒级零网络依赖自愈完成！');
                    } else {
                        Logger.warn('ShellCrash', '⚠️ 路由器本地无冷备或解压失败，启动 14MB Gzip 压缩包上传与备份同步自愈...');
                        const backupDir = config.paths.clashBackup;
                        const localClash = `${backupDir}/Clash`;
                        const localGz = `${backupDir}/Clash.gz`;

                        // 确保容器本地存在 gzip 压缩包，不存在则在容器内即时生成
                        if (fs.existsSync(localClash)) {
                            if (!fs.existsSync(localGz)) {
                                Logger.info('ShellCrash', '正在容器内生成 14MB 高比例 Gzip 压缩内核...');
                                const { execSync } = require('child_process');
                                try {
                                    execSync(`gzip -9 -c "${localClash}" > "${localGz}"`);
                                    Logger.info('ShellCrash', '✅ 本地 14MB Gzip 压缩包创建完成');
                                } catch (gzErr) {
                                    Logger.error('ShellCrash', '本地生成 gzip 压缩包失败', gzErr);
                                }
                            }

                            if (fs.existsSync(localGz)) {
                                Logger.info('ShellCrash', '正在同步 14MB 压缩内核至路由器 /data 闪存冷备分区...');
                                await this.uploadFileLocal(localGz, '/data/ShellCrash/mihomo.bak');
                                Logger.info('ShellCrash', '正在将冷备内核解压至运行目录 /tmp/ShellCrash/mihomo...');
                                await this.runRemoteCommand('gzip -d -c /data/ShellCrash/mihomo.bak > /tmp/ShellCrash/mihomo && chmod +x /tmp/ShellCrash/mihomo');
                                Logger.info('ShellCrash', '✅ Gzip 压缩包自愈和本地冷备同步成功！');
                            } else {
                                // 终极兜底：直接传输 44MB 原始内核
                                Logger.warn('ShellCrash', '⚠️ 压缩包生成失败，降级为直传 44MB 原始内核...');
                                await this.uploadFileLocal(localClash, '/tmp/ShellCrash/mihomo');
                                await this.runRemoteCommand('chmod +x /tmp/ShellCrash/mihomo');
                            }
                        } else {
                            Logger.error('ShellCrash', '❌ 容器内未找到备份的内核文件，自愈失败！');
                        }
                    }
                    
                    // 补全 Country.mmdb (如果 /tmp 中没有或大小不正确)
                    const isGeoDbExist = await this.runRemoteCommand('[ -f /tmp/ShellCrash/Country.mmdb ] && [ $(wc -c < /tmp/ShellCrash/Country.mmdb) -gt 5000000 ] && echo 1 || echo 0');
                    if (isGeoDbExist.trim() !== '1') {
                        if (fs.existsSync(`${backupDir}/Country.mmdb`)) {
                            Logger.info('ShellCrash', '正在从本地备份上传 Country.mmdb 地理数据库...');
                            await this.uploadFileLocal(`${backupDir}/Country.mmdb`, '/tmp/ShellCrash/Country.mmdb');
                        }
                    }
                }

                // 0b. 确保 GeoIP 与 Country.mmdb 软链接正确且不挤爆闪存
                await this.runRemoteCommand('rm -f /data/ShellCrash/geoip.metadb && ln -sf /tmp/ShellCrash/geoip.metadb /data/ShellCrash/geoip.metadb');
                await this.runRemoteCommand('rm -f /data/ShellCrash/Country.mmdb && ln -sf /tmp/ShellCrash/Country.mmdb /data/ShellCrash/Country.mmdb');

                // 0c. 新硬件灾备恢复：检测并重建配置文件
                const isConfigExist = await this.runRemoteCommand('[ -s /data/ShellCrash/config.yaml ] && echo 1 || echo 0');
                if (isConfigExist.trim() !== '1') {
                    Logger.warn('ShellCrash', '⚠️ 探测到路由器 config.yaml 配置丢失或大小为 0，正在执行灾备恢复...');
                    const backupConfig = path.join(config.paths.configsBackup, 'router', 'config.yaml');
                    const backupMac = path.join(config.paths.configsBackup, 'router', 'mac');
                    
                    if (fs.existsSync(backupConfig)) {
                        Logger.info('ShellCrash', '正在将备份的 configs_backup/router/config.yaml 推送到新路由器...');
                        await this.uploadFileLocal(backupConfig, '/data/ShellCrash/config.yaml');
                    } else {
                        Logger.warn('ShellCrash', '⚠️ 未在本地备份中找到 configs_backup/router/config.yaml，尝试重新拉取订阅...');
                    }
                    
                    if (fs.existsSync(backupMac)) {
                        Logger.info('ShellCrash', '正在将备份的 configs_backup/router/mac 推送到新路由器...');
                        await this.runRemoteCommand('mkdir -p /data/ShellCrash/configs');
                        await this.uploadFileLocal(backupMac, '/data/ShellCrash/configs/mac');
                        // 重新注入 iptables 规则
                        await this.ensureIptablesRules().catch(e => {
                            Logger.error('ShellCrash', '灾备恢复时注入 iptables 失败', e);
                        });
                    }
                }

                // 0d. 智能推送防腐：确保最新的安全防火墙引流脚本就绪
                await this.pushIptablesScript().catch(e => {
                    Logger.error('ShellCrash', '重启自愈过程中推送引流脚本失败', e);
                });

                // 1. 杀死旧进程
                await this.runRemoteCommand('killall mihomo Clash 2>/dev/null; true');

                // 2. 等待旧进程完全退出（最多等待 5s）
                for (let i = 0; i < 5; i++) {
                    const pidOut = await this.runRemoteCommand('pidof mihomo || pidof Clash 2>/dev/null || echo ""');
                    if (!pidOut.trim()) {
                        Logger.info('ShellCrash', '旧 Clash 进程已完全退出');
                        break;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }

                // 3. 启动新进程
                await this.runRemoteCommand('( /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null & )');
                Logger.info('ShellCrash', '已下发 Clash 进程启动命令，等待进程启动...');

                // 4. 等待新进程启动（最多等待 15s，给配置加载充足时间）
                let processStarted = false;
                for (let i = 0; i < 15; i++) {
                    const pidOut = await this.runRemoteCommand('pidof mihomo || pidof Clash 2>/dev/null || echo ""');
                    if (pidOut.trim()) {
                        Logger.info('ShellCrash', `进程已启动 (PID: ${pidOut.trim()})`);
                        processStarted = true;

                        // 启动后再等待 5s，确保端口初始化完成
                        Logger.info('ShellCrash', '等待 5s 确保端口绑定完成...');
                        await new Promise(r => setTimeout(r, 5000));
                        break;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }

                if (!processStarted) {
                    Logger.warn('ShellCrash', '进程启动超时（15s 内未找到），但继续执行');
                }

                // 5. 重建 iptables 规则（运行官方 setup_iptables.sh 脚本，安全且包含普通/加速所有设备引流）
                try {
                    await this.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
                    const ruleCount = await this.runRemoteCommand('iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c REDIRECT || echo 0');
                    Logger.info('ShellCrash', `官方 iptables 规则已重建 (${ruleCount.trim()} 条)`);
                } catch (iptablesErr) {
                    Logger.warn('ShellCrash', 'iptables 规则重建失败（非致命）', iptablesErr);
                }

                // 5b. [新增] 写入路由器开机脚本 rc.local 注册自愈 WebHook 回调与 guard_iptables.sh 自启动守护进程
                try {
                    const os = require('os');
                    let localIp = '192.168.31.66'; // fallback
                    const interfaces = os.networkInterfaces();
                    for (const devName in interfaces) {
                        const iface = interfaces[devName];
                        for (let i = 0; i < iface.length; i++) {
                            const alias = iface[i];
                            if (alias.family === 'IPv4' && !alias.internal) {
                                // 优先匹配 192.168. 和 10. 网段，避开 Docker Bridge 虚拟网关 (172.)
                                if (alias.address.startsWith('192.168.') || alias.address.startsWith('10.')) {
                                    localIp = alias.address;
                                    break;
                                }
                            }
                        }
                    }
                    
                    const port = config.port || 3000;
                    
                    // 确保 /etc/rc.local 存在且非空，若空则重置为标准模板
                    await this.runRemoteCommand('[ -s /etc/rc.local ] || (echo -e "#!/bin/sh\\n\\nexit 0" > /etc/rc.local && chmod +x /etc/rc.local)');
                    
                    // 检查是否含有 exit 0
                    const hasExitZero = (await this.runRemoteCommand('grep -q "exit 0" /etc/rc.local && echo 1 || echo 0')).trim() === '1';
                    
                    // 守护进程注入与 WebHook 注入
                    const guardCmd = '( sleep 15 && /data/ShellCrash/guard_iptables.sh ) </dev/null >/dev/null 2>&1 &';
                    const webhookUrl = `http://${localIp}:${port}/api/router-boot-hook`;
                    const webhookCmd = `( sleep 5 && curl -X POST ${webhookUrl} ) </dev/null >/dev/null 2>&1 &`;
                    
                    // 先强行清除已有的旧配置行，防止因 IP 变更或配置变更导致旧配置不刷新
                    await this.runRemoteCommand("sed -i '/mihomo.bak/d' /etc/rc.local 2>/dev/null || true");
                    await this.runRemoteCommand("sed -i '/guard_iptables.sh/d' /etc/rc.local 2>/dev/null || true");
                    await this.runRemoteCommand("sed -i '/router-boot-hook/d' /etc/rc.local 2>/dev/null || true");
                    
                    if (hasExitZero) {
                        // 插入在 exit 0 之前
                        await this.runRemoteCommand(`sed -i '/exit 0/i ${guardCmd}' /etc/rc.local`);
                        await this.runRemoteCommand(`sed -i '/exit 0/i ${webhookCmd}' /etc/rc.local`);
                    } else {
                        // 直接追加在文件末尾
                        await this.runRemoteCommand(`echo "${guardCmd}" >> /etc/rc.local`);
                        await this.runRemoteCommand(`echo "${webhookCmd}" >> /etc/rc.local`);
                    }
                    
                    Logger.info('ShellCrash', '路由器开机自启脚本 rc.local 注入自愈与守护守护成功');
                } catch (rcErr) {
                    Logger.error('ShellCrash', '注入 rc.local 路由器开机自启发生异常', rcErr);
                }

                // 等待 Clash API 就绪（进程存活 ≠ API 可用，268KB 配置加载需额外时间）
                const apiReady = await ClashService.waitClashReady(15);
                if (apiReady) {
                    Logger.info('ShellCrash', 'ShellCrash 分步重启完成，API 已就绪。');
                } else {
                    Logger.warn('ShellCrash', 'Clash API 在 15 秒内未就绪，但进程已启动。');
                }
                lastRestartTime = Date.now();
            } catch (err) {
                const stderrMsg = err.stderr || '';
                const errMsg = (err.error && err.error.message) || '';
                const isClosedByRemote = stderrMsg.includes('closed by remote') ||
                                         errMsg.includes('closed by remote') ||
                                         stderrMsg.includes('Connection') ||
                                         errMsg.includes('Connection') ||
                                         stderrMsg.includes('kex_exchange_identification') ||
                                         errMsg.includes('kex_exchange_identification') ||
                                         (err.error && err.error.code === 255);
                if (isClosedByRemote) {
                    Logger.info('ShellCrash', '探测到因网络重构导致的 SSH 断开连接。此为正常现象，已安全忽略错误。');
                    return;
                }
                Logger.error('ShellCrash', '重启服务发生真实异常', err);
                throw new Error('重启 ShellCrash 失败: ' + (stderrMsg || errMsg));
            }
        });

        // 关键：restartPromise 存储 hard-timeout 包装后的 promise，
        // 且 catch 后必须重置为 resolved，否则一次失败会让整条链永久 rejected
        restartPromise = withHardTimeout(chained, RESTART_HARD_TIMEOUT_MS, 'restartShellCrash').catch(err => {
            Logger.error('ShellCrash', `重启链路熔断：${err.message}，自复位以便后续自愈请求可继续排队`);
            // 不 rethrow：让链路复位为 resolved
        });
        return chained; // 调用方拿到原始 promise（含真实错误），链路状态由 restartPromise 独立管理
    }
}

module.exports = SshService;
module.exports.getLastRestartTime = () => lastRestartTime;
module.exports.updateLastRestartTime = () => { lastRestartTime = Date.now(); };
module.exports.quickRestartShellCrash = SshService.quickRestartShellCrash;
