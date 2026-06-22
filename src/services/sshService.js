const { execFile } = require('child_process');
const { config } = require('../config');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');

let restartPromise = Promise.resolve();
let lastRestartTime = 0;

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
    static runRemoteCommand(command, maxRetries = 3) {
        return this._executeWithRetry(command, 0, maxRetries);
    }

    // 内部实现：带指数退避的命令执行
    static _executeWithRetry(command, attempt = 0, maxRetries = 3) {
        return new Promise((resolve, reject) => {
            try {
                // 安全审计：命令校验
                Validators.validateSSHCommand(command);
            } catch (validationErr) {
                Logger.error('SSH', `命令拦截异常: ${validationErr.message}`);
                return reject(validationErr);
            }

            const sshExecPath = config.paths.sshExec;

            // 使用 execFile 避免本地 shell 注入
            execFile(sshExecPath, [command], (error, stdout, stderr) => {
                if (error) {
                    // 特例：如果是 pgrep 命令返回 1（说明进程不存在），这在 Shell 语法中代表未匹配，应正常处理
                    if (command.includes('pgrep') && error.code === 1) {
                        return resolve('');
                    }

                    // 网络相关错误可重试（包含 Dropbear 并发超载被重置/断开的错误）
                    const isRetryable = error.code === 'ETIMEDOUT' ||
                                       error.code === 'ECONNREFUSED' ||
                                       error.code === 'EHOSTUNREACH' ||
                                       error.code === 255 ||
                                       stderr?.includes('Connection timeout') ||
                                       stderr?.includes('Connection refused') ||
                                       stderr?.includes('Connection reset') ||
                                       stderr?.includes('Connection closed') ||
                                       stderr?.includes('kex_exchange_identification') ||
                                       stdout?.includes('Connection reset') ||
                                       stdout?.includes('Connection closed') ||
                                       stdout?.includes('kex_exchange_identification');

                    if (isRetryable && attempt < maxRetries) {
                        // 指数退避：100ms, 300ms, 900ms
                        const delay = Math.min(100 * Math.pow(3, attempt), 5000);
                        Logger.debug('SSH', `命令执行失败，${delay}ms后进行重试 (${attempt + 1}/${maxRetries})`);
                        setTimeout(() => {
                            this._executeWithRetry(command, attempt + 1, maxRetries).then(resolve).catch(reject);
                        }, delay);
                    } else {
                        Logger.error('SSH', `远程命令执行失败 (已重试${attempt}次): "${command}"`, { error, stderr, stdout });
                        reject({ error, stdout, stderr, attempts: attempt + 1 });
                    }
                } else {
                    const cleaned = this._cleanOutput(stdout);
                    resolve(cleaned);
                }
            });
        });
    }

    // 上传容器本地文件到路由器（通过 scp_to_remote.exp 脚本）
    static uploadFileLocal(localPath, remotePath) {
        return new Promise((resolve, reject) => {
            const scpScript = config.paths.sshExec.replace('ssh_wrapper.sh', 'scp_to_remote.exp');
            const env = {
                ...process.env,
                ROUTER_IP: config.router.ip,
                ROUTER_USER: config.router.user,
                ROUTER_PASSWORD: config.router.password
            };
            execFile(scpScript, [localPath, remotePath], { env }, (error, stdout, stderr) => {
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

    // 确保 iptables 规则存在（路由器重启后恢复）
    static async ensureIptablesRules() {
        try {
            await this.runRemoteCommand('mkdir -p /var/run');
            await this.runRemoteCommand(
                'iptables -t nat -F PREROUTING 2>/dev/null; ' +
                'while read mac; do ' +
                '[ -n "$mac" ] && iptables -t nat -A PREROUTING -m mac --mac-source $mac -p udp --dport 53 -j REDIRECT --to-ports 1053; ' +
                '[ -n "$mac" ] && iptables -t nat -A PREROUTING -m mac --mac-source $mac -p tcp -j REDIRECT --to-ports 7892; ' +
                'done < /data/ShellCrash/configs/mac'
            );
            const ruleCount = await this.runRemoteCommand('iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c REDIRECT || echo 0');
            Logger.info('ShellCrash', `iptables 规则已初始化 (${ruleCount.trim()} 条)`);
        } catch (err) {
            Logger.warn('ShellCrash', 'iptables 规则初始化失败', err);
            throw err;
        }
    }

    // 安全重启 ShellCrash，带串行排队锁和正确的启动等待逻辑
    static async restartShellCrashSecurely() {
        restartPromise = restartPromise.then(async () => {
            try {
                Logger.info('ShellCrash', '正在请求重启 ShellCrash 服务 (排队中)...');

                // 0. 清除启动锁定文件（确保不会因旧失败状态锁定）
                await this.runRemoteCommand('rm -f /data/ShellCrash/.start_error');
                Logger.info('ShellCrash', '已清除启动错误标记文件');

                // 0a. 路由器重启后自动补全内核与地理数据库
                const isKernelExist = await this.runRemoteCommand('[ -f /tmp/ShellCrash/mihomo ] && echo 1 || echo 0');
                if (isKernelExist.trim() !== '1') {
                    Logger.info('ShellCrash', '⚠️ 探测到路由器重启导致 /tmp 内核丢失，正在执行全自动自愈补全...');
                    await this.runRemoteCommand('mkdir -p /tmp/ShellCrash');
                    
                    const fs = require('fs');
                    const backupDir = config.paths.clashBackup;
                    
                    if (fs.existsSync(`${backupDir}/Clash`) && fs.existsSync(`${backupDir}/Country.mmdb`)) {
                        Logger.info('ShellCrash', '正在从本地备份全自动上传 Clash 内核与 Country.mmdb 到路由器...');
                        await this.uploadFileLocal(`${backupDir}/Clash`, '/tmp/ShellCrash/mihomo');
                        await this.uploadFileLocal(`${backupDir}/Country.mmdb`, '/tmp/ShellCrash/Country.mmdb');
                        await this.runRemoteCommand('chmod +x /tmp/ShellCrash/mihomo');
                        Logger.info('ShellCrash', '✅ 文件推送及权限配置完成！');
                    } else {
                        Logger.error('ShellCrash', '❌ 容器内未找到备份的内核或数据库文件，自愈失败！');
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

                // 更新最后重启时间
                lastRestartTime = Date.now();
                Logger.info('ShellCrash', 'ShellCrash 已成功完成分步重启。');
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
        return restartPromise;
    }
}

module.exports = SshService;
module.exports.getLastRestartTime = () => lastRestartTime;
