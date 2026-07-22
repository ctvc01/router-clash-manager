// 结构化日志工具类，提供统一的时间戳和级别输出，支持文件轮转

const fs = require('fs');
const path = require('path');

class Logger {
    static MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB —— 减小轮转文件大小，降低单次写入压力
    static MIN_ROTATION_INTERVAL_MS = 60000; // 轮转最小间隔 60s，防止频繁 rename 触发 EPIPE
    static _lastRotationTime = 0;            // 上次轮转时间戳
    static LOG_DIR = process.env.LOG_DIR || (
        process.env.NODE_ENV === 'production' 
            ? '/data/logs' 
            : path.join(__dirname, '..', '..', 'logs')
    );
    static LOG_FILE = path.join(Logger.LOG_DIR, 'app.log');
    static logFileSize = 0;
    static _lastErrorTime = 0;       // 错误日志限流：上次错误时间戳
    static _errorCount = 0;          // 错误日志限流：连续错误计数
    static _epipeSafeMode = false;   // 当检测到 console EPIPE 时进入安全模式，跳过 console.* 输出
    static _epipeResetTimer = null;  // EPIPE 安全模式定时重置器

    // 安全地调用 console.*，捕获 EPIPE 并切换至文件安全模式
    static _safeConsole(method, ...args) {
        if (Logger._epipeSafeMode) return;
        try {
            console[method](...args);
        } catch (e) {
            if (e.code === 'EPIPE' || (e.stack && e.stack.includes('EPIPE'))) {
                Logger._epipeSafeMode = true;
                // 只设置标志，不写文件，避免 EPIPE 风暴填满日志
                if (Logger._epipeResetTimer) clearTimeout(Logger._epipeResetTimer);
                Logger._epipeResetTimer = setTimeout(() => {
                    Logger._epipeSafeMode = false;
                    Logger._epipeResetTimer = null;
                }, 30000);
            }
        }
    }

    // 错误日志限流：1秒内超过3次错误则静默，防止递归循环打爆文件
    static _shouldRateLimit() {
        const now = Date.now();
        if (now - Logger._lastErrorTime < 1000) {
            Logger._errorCount++;
            return Logger._errorCount > 3;
        }
        Logger._lastErrorTime = now;
        Logger._errorCount = 0;
        return false;
    }

    // 初始化日志目录
    static initialize() {
        try {
            if (!fs.existsSync(Logger.LOG_DIR)) {
                fs.mkdirSync(Logger.LOG_DIR, { recursive: true });
            }
            if (fs.existsSync(Logger.LOG_FILE)) {
                const stat = fs.statSync(Logger.LOG_FILE);
                Logger.logFileSize = stat.size;
            }
        } catch (e) {
            // 如果创建失败，后续写入会被忽略
            console.error('Failed to initialize log directory', e.message);
        }
    }

    // 日志文件轮转
    static _rotateLogIfNeeded() {
        try {
            // 增加最小轮转间隔检查，防止频繁 rename 触发 EPIPE
            if (Logger.logFileSize >= Logger.MAX_LOG_SIZE && Date.now() - Logger._lastRotationTime > Logger.MIN_ROTATION_INTERVAL_MS) {
                const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                const backupFile = path.join(Logger.LOG_DIR, `app.log.${timestamp}`);
                try {
                    fs.renameSync(Logger.LOG_FILE, backupFile);
                } catch (renameErr) {
                    // 如果文件已被其他进程轮转，忽略重命名错误
                    Logger.logFileSize = 0;
                    return;
                }
                Logger._lastRotationTime = Date.now();
                Logger.logFileSize = 0;

                // 清理超过10个备份文件的最旧记录
                const files = fs.readdirSync(Logger.LOG_DIR)
                    .filter(f => f.startsWith('app.log.'))
                    .sort()
                    .reverse();
                if (files.length > 10) {
                    files.slice(10).forEach(f => {
                        try {
                            fs.unlinkSync(path.join(Logger.LOG_DIR, f));
                        } catch (e) {
                            // 忽略删除失败
                        }
                    });
                }
            }
        } catch (e) {
            // 轮转失败不影响程序运行
        }
    }

    // 写入日志文件
    static _writeToFile(line) {
        try {
            fs.appendFileSync(Logger.LOG_FILE, line + '\n', 'utf8');
            Logger.logFileSize += line.length + 1;
            this._rotateLogIfNeeded();
        } catch (e) {
            // 文件写入失败不影响控制台输出
        }
    }

    // 获取当前 UTC+8 时间戳字符串
    static _getTimestamp() {
        return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(' ', 'T') + '+08:00';
    }

    static info(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        const line = `[${time}] ℹ️  [${tag}] ${msg}${dataStr}`;
        this._safeConsole('log', line);
        this._writeToFile(line);
    }

    static warn(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Details: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        const line = `[${time}] ⚠️  [${tag}] ${msg}${dataStr}`;
        this._safeConsole('warn', line);
        this._writeToFile(line);
    }

    static error(tag, msg, error = null) {
        // 限流：防止递归循环打爆日志
        if (this._shouldRateLimit()) return;

        const time = this._getTimestamp();
        const line = `[${time}] ❌ [${tag}] ${msg}`;
        if (!Logger._epipeSafeMode) this._safeConsole('error', line);
        this._writeToFile(line);
        if (error) {
            if (error.stack) {
                const stackLine = `    Stack: ${error.stack}`;
                if (!Logger._epipeSafeMode) this._safeConsole('error', stackLine);
                this._writeToFile(stackLine);
            } else if (error.message) {
                const msgLine = `    Message: ${error.message}`;
                if (!Logger._epipeSafeMode) this._safeConsole('error', msgLine);
                this._writeToFile(msgLine);
            } else {
                const detailLine = `    Details: ${JSON.stringify(error)}`;
                if (!Logger._epipeSafeMode) this._safeConsole('error', detailLine);
                this._writeToFile(detailLine);
            }
        }
    }

    static debug(tag, msg, data = null) {
        if (process.env.DEBUG === 'true') {
            const time = this._getTimestamp();
            const dataStr = data ? ` | DebugData: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
            const line = `[${time}] 🔍 [${tag}] ${msg}${dataStr}`;
            this._safeConsole('log', line);
            this._writeToFile(line);
        }
    }
}

// 启动时初始化日志系统
Logger.initialize();

module.exports = Logger;
