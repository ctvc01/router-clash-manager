const fs = require('fs');
const path = require('path');
const Logger = require('../utils/logger');

class AdBlockService {
    constructor() {
        this.cache = null;
        this.lastMtime = 0;
        this.confPath = path.join(__dirname, '..', '..', 'Shadowrocket.conf');
    }

    getAdBlockHosts() {
        try {
            if (!fs.existsSync(this.confPath)) {
                return {};
            }

            const stat = fs.statSync(this.confPath);
            if (this.cache && this.lastMtime === stat.mtimeMs) {
                return this.cache;
            }

            Logger.info('AdBlock', '检测到 Shadowrocket.conf 有更新，正在解析广告拦截域名...');
            const content = fs.readFileSync(this.confPath, 'utf8');
            const lines = content.split('\n');
            const hosts = {};

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#') || line.startsWith('//')) {
                    continue;
                }

                // 支持 DOMAIN-SUFFIX,domain,REJECT 以及 DOMAIN,domain,REJECT
                const parts = line.split(',');
                if (parts.length >= 3) {
                    const type = parts[0].trim().toUpperCase();
                    const domain = parts[1].trim();
                    const action = parts[2].trim().toUpperCase();

                    if (action === 'REJECT') {
                        if (type === 'DOMAIN-SUFFIX') {
                            hosts[`*.${domain}`] = '0.0.0.0';
                        } else if (type === 'DOMAIN') {
                            hosts[domain] = '0.0.0.0';
                        }
                    }
                }
            }

            this.cache = hosts;
            this.lastMtime = stat.mtimeMs;
            Logger.info('AdBlock', `成功解析到 ${Object.keys(hosts).length} 个广告/追踪黑名单 Hosts`);
            return hosts;
        } catch (err) {
            Logger.error('AdBlock', '解析 Shadowrocket.conf 发生异常', err);
            return this.cache || {};
        }
    }
}

module.exports = new AdBlockService();
