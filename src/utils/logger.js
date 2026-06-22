// 结构化日志工具类，提供统一的时间戳和级别输出，支持文件轮转

const fs = require('fs');
const path = require('path');

class Logger {
    static MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
    static LOG_DIR = process.env.LOG_DIR || (
        process.env.NODE_ENV === 'production' 
            ? '/data/logs' 
            : path.join(__dirname, '..', '..', 'logs')
    );
    static LOG_FILE = path.join(Logger.LOG_DIR, 'app.log');
    static logFileSize = 0;

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
            if (Logger.logFileSize >= Logger.MAX_LOG_SIZE) {
                const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                const backupFile = path.join(Logger.LOG_DIR, `app.log.${timestamp}`);
                fs.renameSync(Logger.LOG_FILE, backupFile);
                Logger.logFileSize = 0;

                // 清理超过5个备份文件的最旧记录
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

    // 获取当前 UTC+8 时间戳字符串
    static _getTimestamp() {
        const now = new Date();
        const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        return utc8Time.toISOString().replace('Z', '+08:00');
    }

    static info(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        const line = `[${time}] ℹ️  [${tag}] ${msg}${dataStr}`;
        console.log(line);
        this._writeToFile(line);
    }

    static warn(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Details: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        const line = `[${time}] ⚠️  [${tag}] ${msg}${dataStr}`;
        console.warn(line);
        this._writeToFile(line);
    }

    static error(tag, msg, error = null) {
        const time = this._getTimestamp();
        const line = `[${time}] ❌ [${tag}] ${msg}`;
        console.error(line);
        this._writeToFile(line);
        if (error) {
            if (error.stack) {
                const stackLine = `    Stack: ${error.stack}`;
                console.error(stackLine);
                this._writeToFile(stackLine);
            } else if (error.message) {
                const msgLine = `    Message: ${error.message}`;
                console.error(msgLine);
                this._writeToFile(msgLine);
            } else {
                const detailLine = `    Details: ${JSON.stringify(error)}`;
                console.error(detailLine);
                this._writeToFile(detailLine);
            }
        }
    }

    static debug(tag, msg, data = null) {
        if (process.env.DEBUG === 'true') {
            const time = this._getTimestamp();
            const dataStr = data ? ` | DebugData: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
            const line = `[${time}] 🔍 [${tag}] ${msg}${dataStr}`;
            console.log(line);
            this._writeToFile(line);
        }
    }
}

// 启动时初始化日志系统
Logger.initialize();

module.exports = Logger;
