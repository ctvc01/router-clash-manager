// 结构化日志工具类，提供统一的时间戳和级别输出，支持文件轮转

const fs = require('fs');
const path = require('path');

class Logger {
    static MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB —— 减小轮转文件大小，降低单次写入压力和磁盘占用
    static MIN_ROTATION_INTERVAL_MS = 60000; // 轮转最小间隔 60s，防止频繁 rename 触发 EPIPE
    static TRIM_THRESHOLD = 1 * 1024 * 1024; // 1MB —— 超过此值触发主动修剪，保留最近日志
    static MAX_LOG_LINES = 2000;             // 修剪时保留的最后行数
    static MAX_TOTAL_LOG_SIZE = 10 * 1024 * 1024; // 10MB —— 日志目录总大小硬限制，超过时从最旧的轮转文件开始删
    static SMALL_FILE_THRESHOLD = 100 * 1024;       // 100KB —— 小文件阈值，低于此值时延长检查间隔
    static MEDIUM_FILE_THRESHOLD = 500 * 1024;      // 500KB —— 中等文件阈值
    static SMALL_FILE_INTERVAL = 30 * 60 * 1000;    // 30分钟 —— 小文件检查间隔
    static MEDIUM_FILE_INTERVAL = 15 * 60 * 1000;   // 15分钟 —— 中等文件检查间隔
    static LARGE_FILE_INTERVAL = 5 * 60 * 1000;     // 5分钟 —— 大文件检查间隔
    static AGGRESSIVE_INTERVAL = 2 * 60 * 1000;     // 2分钟 —— 超大文件（>1MB）检查间隔
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
    static _cleanupTimer = null;     // 日志文件自动修剪定时器（自适应间隔）

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
            // 启动自动清理定时器
            Logger.startAutoCleanup();
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
                if (files.length > 5) {
                    files.slice(5).forEach(f => {
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


    // 清理日志目录：当总大小超过 MAX_TOTAL_LOG_SIZE 时，删除最旧的轮转文件释放空间
    static _cleanupLogDir() {
        try {
            if (!fs.existsSync(Logger.LOG_DIR)) return;
            const files = fs.readdirSync(Logger.LOG_DIR)
                .filter(f => f.startsWith('app.log'))
                .map(f => ({
                    name: f,
                    path: path.join(Logger.LOG_DIR, f),
                    isRotated: f.startsWith('app.log.')
                }))
                .sort((a, b) => {
                    if (a.isRotated !== b.isRotated) return a.isRotated ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            let totalSize = 0;
            for (const f of files) {
                try { totalSize += fs.statSync(f.path).size; } catch (_) {}
            }

            if (totalSize <= Logger.MAX_TOTAL_LOG_SIZE) return;

            const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
            Logger._safeConsole('log', `[Logger] 日志目录总大小 ${sizeMB}MB 超过限制 (${Logger.MAX_TOTAL_LOG_SIZE / 1024 / 1024}MB)，开始清理`);

            // 从最旧的轮转文件开始删除，直到总大小低于阈值的 80%
            const targetSize = Math.floor(Logger.MAX_TOTAL_LOG_SIZE * 0.8);
            let deleted = 0;
            for (const f of files) {
                if (totalSize <= targetSize) break;
                if (!f.isRotated) continue;
                try {
                    const stat = fs.statSync(f.path);
                    fs.unlinkSync(f.path);
                    totalSize -= stat.size;
                    deleted++;
                } catch (_) {}
            }

            // 如果删完轮转文件后总大小仍超限，对主文件执行激进修剪（保留最近 500 行）
            if (totalSize > Logger.MAX_TOTAL_LOG_SIZE) {
                const mainFile = files.find(f => !f.isRotated);
                if (mainFile && fs.existsSync(mainFile.path)) {
                    const content = fs.readFileSync(mainFile.path, 'utf8');
                    const lines = content.split('\n');
                    if (lines.length > 500) {
                        const trimmed = lines.slice(-500).join('\n');
                        fs.writeFileSync(mainFile.path, trimmed, 'utf8');
                        totalSize = trimmed.length;
                        Logger._safeConsole('log', `[Logger] 日志目录总大小仍超限，已对主文件执行激进修剪（保留最近 500 行）`);
                    }
                }
            }

            Logger.logFileSize = fs.existsSync(Logger.LOG_FILE) ? fs.statSync(Logger.LOG_FILE).size : 0;
            Logger._safeConsole('log', `[Logger] 日志清理完成: 删除了 ${deleted} 个轮转文件，当前总大小 ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
        } catch (e) {
            // 清理失败不影响程序运行
        }
    }

    // 根据日志文件大小选择自适应检查间隔，文件小→延长周期减少不必要 I/O
    static _getAdaptiveInterval() {
        try {
            if (!fs.existsSync(Logger.LOG_FILE)) return Logger.SMALL_FILE_INTERVAL;
            const size = fs.statSync(Logger.LOG_FILE).size;
            if (size >= Logger.TRIM_THRESHOLD) return Logger.AGGRESSIVE_INTERVAL;
            if (size >= Logger.MEDIUM_FILE_THRESHOLD) return Logger.LARGE_FILE_INTERVAL;
            if (size >= Logger.SMALL_FILE_THRESHOLD) return Logger.MEDIUM_FILE_INTERVAL;
            return Logger.SMALL_FILE_INTERVAL;
        } catch (_) {
            return Logger.SMALL_FILE_INTERVAL;
        }
    }

    // 主动修剪日志文件：如果超过阈值，保留最近 MAX_LOG_LINES 行，删除较早的日志
    static _trimLogFile() {
        try {
            if (!fs.existsSync(Logger.LOG_FILE)) return;
            const stat = fs.statSync(Logger.LOG_FILE);
            if (stat.size < Logger.TRIM_THRESHOLD) return;

            const content = fs.readFileSync(Logger.LOG_FILE, 'utf8');
            const lines = content.split('\n');
            // 空文件或行数不足时不处理
            if (lines.length <= Logger.MAX_LOG_LINES) return;

            // 保留最后 MAX_LOG_LINES 行
            const trimmed = lines.slice(-Logger.MAX_LOG_LINES).join('\n');
            fs.writeFileSync(Logger.LOG_FILE, trimmed, 'utf8');
            Logger.logFileSize = trimmed.length;

            const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
            Logger._safeConsole('log', `[Logger] 日志文件超过限制 (${sizeMB}MB)，已修剪至最后 ${Logger.MAX_LOG_LINES} 行`);
        } catch (e) {
            // 修剪失败不影响程序运行
        }
    }

    // 启动定时自动清理日志文件
    static startAutoCleanup() {
        if (Logger._cleanupTimer) return;
        // 启动后 5 秒首次检查（同时修剪单文件和清理目录总大小）
        setTimeout(() => {
            Logger._trimLogFile();
            Logger._cleanupLogDir();
        }, 5000);
        // 使用自适应间隔调度后续检查，文件小→延长周期，文件大→加密检查
        const scheduleNext = () => {
            const interval = Logger._getAdaptiveInterval();
            Logger._cleanupTimer = setTimeout(() => {
                Logger._trimLogFile();
                Logger._cleanupLogDir();
                scheduleNext();
            }, interval);
        };
        scheduleNext();
    }

    // 停止自动清理定时器
    static stopAutoCleanup() {
        if (Logger._cleanupTimer) {
            clearTimeout(Logger._cleanupTimer);
            Logger._cleanupTimer = null;
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
