const { execFile } = require('child_process');
const { config } = require('../config');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');

let restartPromise = Promise.resolve();

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

    // 执行远程命令
    static runRemoteCommand(command) {
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
                    Logger.error('SSH', `远程命令执行失败: "${command}"`, { error, stderr });
                    return reject({ error, stderr });
                }
                const cleaned = this._cleanOutput(stdout);
                resolve(cleaned);
            });
        });
    }

    // 安全重启 ShellCrash，带串行排队锁，容忍因防火墙/路由重构导致的假性 SSH 断线
    static async restartShellCrashSecurely() {
        restartPromise = restartPromise.then(async () => {
            try {
                Logger.info('ShellCrash', '正在请求重启 ShellCrash 服务 (排队中)...');
                // 额外缓冲 1.5 秒确保上一次关闭的旧 ClashCore 完全释放本地端口
                await this.runRemoteCommand('sleep 1.5');
                await this.runRemoteCommand('/etc/init.d/shellcrash stop && /etc/init.d/shellcrash start');
                Logger.info('ShellCrash', 'ShellCrash 重启命令同步执行成功。');
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
