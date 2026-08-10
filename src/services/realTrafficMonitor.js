const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const SshService = require('./sshService');
const GameAccService = require('./gameAccService');

const POLL_INTERVAL_MS = 5000;
const IP_CACHE_TTL_MS = 60000;
const CONN_TRACK_TTL_MS = 45000;
const NODE_STALE_MS = 60000;
const EMA_ALPHA = 0.4;

class RealTrafficMonitor {
    static _timer = null;
    static _ipCache = { value: [], time: 0 };
    static _connSeen = new Map();      // connId -> { node, bytes, lastSeen }
    static _nodeCumulative = new Map(); // node -> { bytes, lastBytes, lastTime, ema }
    static _stats = new Map();          // node -> { realDownloadMbps, totalBytes, lastSeen }

    static start() {
        if (this._timer) return;
        Logger.info('RealTraffic', '真实下载流量校准监控已启动 (5s 轮询)');
        this._timer = setInterval(() => { this._poll().catch(() => {}); }, POLL_INTERVAL_MS);
        this._poll().catch(() => {});
    }

    static stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._stats.clear();
        this._connSeen.clear();
        this._nodeCumulative.clear();
        Logger.info('RealTraffic', '真实下载流量校准监控已停止');
    }

    static getStats() {
        const out = {};
        for (const [node, stat] of this._stats) {
            if (Date.now() - stat.lastSeen > NODE_STALE_MS) continue;
            out[node] = { ...stat };
        }
        return out;
    }

    static async _getGameIps(gameMacs) {
        if (this._ipCache.value.length > 0 && Date.now() - this._ipCache.time < IP_CACHE_TTL_MS) {
            return this._ipCache.value;
        }
        try {
            const leases = await SshService.runRemoteCommand(
                'cat /tmp/dhcp.leases 2>/dev/null || cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /data/dhcp.leases 2>/dev/null || cat /proc/net/arp 2>/dev/null || echo ""'
            ).catch(() => '');
            const dhcpLeases = {};
            for (const line of (leases || '').split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) dhcpLeases[parts[1].toLowerCase()] = parts[2];
            }
            const ips = gameMacs.map(mac => dhcpLeases[mac.toLowerCase()]).filter(Boolean);
            this._ipCache = { value: ips, time: Date.now() };
            return ips;
        } catch (err) {
            Logger.debug('RealTraffic', `获取游戏设备 IP 失败: ${err.message}`);
            return this._ipCache.value;
        }
    }

    static async _poll() {
        const gameMacs = GameAccService.readGameDevices();
        if (gameMacs.length === 0) {
            this.stop();
            return;
        }
        const gameIps = await this._getGameIps(gameMacs);
        if (gameIps.length === 0) return;

        const conns = await ClashService.getConnections(3000);
        const ipSet = new Set(gameIps);
        const now = Date.now();
        const seenIds = new Set();
        const nodeActiveBytes = new Map();

        for (const c of conns) {
            const src = c.metadata && c.metadata.sourceIP;
            if (!src || !ipSet.has(src)) continue;
            const chains = Array.isArray(c.chains) ? c.chains : [];
            if (chains.length < 2) continue;
            const node = chains[0];
            if (!node || node === 'DIRECT' || node === 'GLOBAL' || node === 'REJECT') continue;
            const bytes = typeof c.download === 'number' ? c.download : 0;
            seenIds.add(c.id);
            const prev = this._connSeen.get(c.id);
            if (!prev || bytes > prev.bytes) {
                this._connSeen.set(c.id, { node, bytes, lastSeen: now });
            } else {
                this._connSeen.get(c.id).lastSeen = now;
            }
            nodeActiveBytes.set(node, (nodeActiveBytes.get(node) || 0) + bytes);
        }

        // 清理已消失的连接记录
        for (const [id, rec] of this._connSeen) {
            if (!seenIds.has(id) && now - rec.lastSeen > CONN_TRACK_TTL_MS) {
                this._connSeen.delete(id);
            }
        }

        // 按节点累计本采样窗口字节，计算实时带宽
        const nodeTotals = new Map();
        for (const rec of this._connSeen.values()) {
            nodeTotals.set(rec.node, (nodeTotals.get(rec.node) || 0) + rec.bytes);
        }

        for (const [node, totalBytes] of nodeTotals) {
            const prevRec = this._nodeCumulative.get(node);
            if (prevRec) {
                const deltaBytes = Math.max(0, totalBytes - prevRec.lastBytes);
                const deltaTime = now - prevRec.lastTime;
                if (deltaTime > 0 && deltaBytes > 0) {
                    const rate = (deltaBytes * 8) / deltaTime / 1e6;
                    const ema = prevRec.ema > 0 ? prevRec.ema * (1 - EMA_ALPHA) + rate * EMA_ALPHA : rate;
                    this._stats.set(node, {
                        realDownloadMbps: Number(ema.toFixed(2)),
                        totalBytes,
                        lastSeen: now
                    });
                    this._nodeCumulative.set(node, { bytes: totalBytes, lastBytes: totalBytes, lastTime: now, ema });
                } else {
                    this._nodeCumulative.get(node).lastTime = now;
                    this._nodeCumulative.get(node).bytes = totalBytes;
                    this._nodeCumulative.get(node).lastBytes = totalBytes;
                }
            } else {
                this._nodeCumulative.set(node, { bytes: totalBytes, lastBytes: totalBytes, lastTime: now, ema: 0 });
            }
        }

        // 清理无流量的节点累计记录
        for (const [node, rec] of this._nodeCumulative) {
            if (now - rec.lastTime > NODE_STALE_MS) {
                this._nodeCumulative.delete(node);
            }
        }
    }
}

module.exports = RealTrafficMonitor;
