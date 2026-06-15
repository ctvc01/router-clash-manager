// 结构化日志工具类，提供统一的时间戳和级别输出

class Logger {
    // 获取当前 UTC+8 时间戳字符串
    static _getTimestamp() {
        const now = new Date();
        // 转换为 UTC+8 时间并格式化
        const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        return utc8Time.toISOString().replace('Z', '+08:00');
    }

    static info(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        console.log(`[${time}] ℹ️  [${tag}] ${msg}${dataStr}`);
    }

    static warn(tag, msg, data = null) {
        const time = this._getTimestamp();
        const dataStr = data ? ` | Details: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
        console.warn(`[${time}] ⚠️  [${tag}] ${msg}${dataStr}`);
    }

    static error(tag, msg, error = null) {
        const time = this._getTimestamp();
        console.error(`[${time}] ❌ [${tag}] ${msg}`);
        if (error) {
            if (error.stack) {
                console.error(`    Stack: ${error.stack}`);
            } else if (error.message) {
                console.error(`    Message: ${error.message}`);
            } else {
                console.error(`    Details: ${JSON.stringify(error)}`);
            }
        }
    }

    static debug(tag, msg, data = null) {
        if (process.env.DEBUG === 'true') {
            const time = this._getTimestamp();
            const dataStr = data ? ` | DebugData: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
            console.log(`[${time}] 🔍 [${tag}] ${msg}${dataStr}`);
        }
    }
}

module.exports = Logger;
