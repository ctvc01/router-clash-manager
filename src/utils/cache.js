// 轻量级内存缓存管理器

class CacheManager {
    constructor() {
        this.cache = new Map();
        this.timeouts = new Map();
    }

    // 设置缓存，以秒为单位
    set(key, value, ttlSeconds = 15) {
        // 如果已存在超时清理，先删除
        if (this.timeouts.has(key)) {
            clearTimeout(this.timeouts.get(key));
        }

        this.cache.set(key, value);
        
        const timeoutId = setTimeout(() => {
            this.cache.delete(key);
            this.timeouts.delete(key);
        }, ttlSeconds * 1000);
        
        // 允许进程优雅退出，不因为缓存定时器卡住
        if (timeoutId.unref) {
            timeoutId.unref();
        }

        this.timeouts.set(key, timeoutId);
    }

    // 获取缓存
    get(key) {
        return this.cache.get(key) || null;
    }

    // 清理特定的缓存
    clear(key) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        if (this.timeouts.has(key)) {
            clearTimeout(this.timeouts.get(key));
            this.timeouts.delete(key);
        }
    }

    // 清理全部缓存
    clearAll() {
        for (const [key, timeoutId] of this.timeouts.entries()) {
            clearTimeout(timeoutId);
        }
        this.cache.clear();
        this.timeouts.clear();
    }
}

// 导出全局单例
const cache = new CacheManager();
module.exports = cache;
