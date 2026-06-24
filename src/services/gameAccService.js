const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const PersistenceService = require('./persistenceService');
const SpeedtestState = require('./speedtestState');

let gameAccCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let gameAccStartTimeout = null;
let silentPeriodicalTimer = null;
let silentStartTimeout = null;

class GameAccService {
    static readGameDevices() {
        const data = PersistenceService.readText(config.paths.gameDevices, '');
        return data.split('\n').map(line => line.trim().toLowerCase()).filter(line => line.length > 0);
    }
    static writeGameDevices(devices) {
        return PersistenceService.writeText(config.paths.gameDevices, devices.join('\n') + '\n');
    }

    // 优先丢包率 → 加权延迟（Japan/Taiwan/Korea region bias + gRPC penalty）
    static async findFastestGameNode() {
        try {
            Logger.info('GameAcc', '🔍 5-采样 Nintendo CDN测速 日本加权 gRPC惩罚...');
            const proxiesData = await ClashService.getProxies(6000);
            const group = proxiesData.proxies['⚡ 游戏自动测速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 ⚡ 游戏自动测速 组，无法自动寻优');
                return null;
            }
            const NODE_SAMPLES = 5;
            const TIMEOUT_MS = 3000;
            const TEST_URLS = ['http://ctest.cdn.nintendo.net/', 'http://atum.download.nintendo.net/'];
            
            const results = [];
            for (const nodeName of group.all) {
                let successCount = 0, totalDelay = 0;
                for (let i = 0; i < NODE_SAMPLES; i++) {
                    const url = i < 3 ? TEST_URLS[0] : TEST_URLS[1];
                    const delay = await ClashService.testNodeDelay(nodeName, TIMEOUT_MS, url);
                    if (delay > 0) { successCount++; totalDelay += delay; }
                    if (i < NODE_SAMPLES - 1) await new Promise(r => setTimeout(r, 200));
                }
                const lossRate = (NODE_SAMPLES - successCount) / NODE_SAMPLES;
                const avgDelay = successCount > 0 ? Math.round(totalDelay / successCount) : 99999;
                const lowerName = nodeName.toLowerCase();
                const isJapan = lowerName.includes('japan') || lowerName.includes('日本') || lowerName.includes('jp');
                const isTaiwan = lowerName.includes('taiwan') || lowerName.includes('台灣') || lowerName.includes('台湾') || lowerName.includes('tw');
                const isKorea = lowerName.includes('korea') || lowerName.includes('韩国') || lowerName.includes('kr');
                const isGRPC = lowerName.includes('grpc');
                let weight = 1.0;
                if (isJapan) weight = 0.75; else if (isTaiwan) weight = 0.85; else if (isKorea) weight = 0.90;
                if (isGRPC && !isJapan) weight *= 1.15;
                const weightedDelay = successCount > 0 ? Math.round(avgDelay * weight) : 99999;
                results.push({ name: nodeName, delay: weightedDelay, rawDelay: avgDelay, loss: lossRate, samples: successCount, region: isJapan ? 'JP' : (isTaiwan ? 'TW' : (isKorea ? 'KR' : 'OTHER')), isGRPC });
            }
            if (results.length === 0) { Logger.warn('GameAcc', '无可用游戏节点'); return null; }
            results.sort((a, b) => { if (a.loss !== b.loss) return a.loss - b.loss; return a.delay - b.delay; });
            const best = results[0];
            const lossPct = (best.loss * 100).toFixed(0);
            Logger.info('GameAcc', `✅ 最优: ${best.name} raw=${best.rawDelay}ms loss=${lossPct}% ${best.region}${best.isGRPC?' gRPC':''}`);
            SpeedtestState.updateResult('game', { name: best.name, delay: best.rawDelay, loss: best.loss, samples: best.samples });
            SpeedtestState.updateGamePerNodeResults(results);
            return { name: best.name, delay: best.rawDelay, loss: best.loss, samples: best.samples };
        } catch (err) { Logger.error('GameAcc', '寻找最快节点时发生异常', err); return null; }
    }

    static async lockGameNode(nodeName) {
        if (!nodeName) return false;
        try { return await ClashService.selectProxyNode('🎮 游戏加速', nodeName); }
        catch (err) { Logger.error('GameAcc', `锁定游戏策略组发生异常: ${nodeName}`, err); return false; }
    }

    static async findBestAndLock(force) {
        const best = await this.findFastestGameNode();
        if (best) { SpeedtestState.updateResult('game', best); if (force || !SpeedtestState.isLocked('game')) await this.lockGameNode(best.name); }
        return best;
    }

    static _getBeijingTimeParts() {
        const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
        const parts = formatter.formatToParts(new Date());
        const hourPart = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        return { hour: hourPart ? parseInt(hourPart.value, 10) : 0, minute: minutePart ? parseInt(minutePart.value, 10) : 0 };
    }

    static startGameAccMonitor() {
        if (gameAccCheckTimer || gameAccStartTimeout) return;
        gameAccStartTimeout = setTimeout(() => {
            gameAccStartTimeout = null;
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) return;
            Logger.info('GameAcc', '🛡️ 游戏加速故障心跳检测正式启动 (周期 5 分钟)');
            this._checkGameNodeHealth();
            gameAccCheckTimer = setInterval(async () => { await this._checkGameNodeHealth(); }, 300000);
        }, 120000);
        Logger.info('GameAcc', '🛡️ 游戏加速故障心跳已排程，将在 120 秒后错峰激活 (周期 5 分钟)');
        if (!silentPeriodicalTimer && !silentStartTimeout) {
            silentStartTimeout = setTimeout(() => {
                silentStartTimeout = null;
                const gameMacs = this.readGameDevices();
                if (gameMacs.length === 0) return;
                Logger.info('GameAcc', '🕰️ 游戏节点后台静默测速优化任务正式启动 (周期 30 分钟)');
                this.runSilentPeriodicalCheck();
                silentPeriodicalTimer = setInterval(() => this.runSilentPeriodicalCheck(), 1800000);
            }, 480000);
            Logger.info('GameAcc', '🕰️ 游戏后台静默测速优化已排程，将在 8 分钟后错峰激活 (周期 30 分钟)');
        }
    }

    static async _checkGameNodeHealth() {
        const gameMacs = this.readGameDevices();
        if (gameMacs.length === 0) { this.stopGameAccMonitor(); return; }
        try {
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.now) return;
            const currentNode = group.now;
            if (['⚡ 游戏自动测速', '🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) return;
            const delay = await ClashService.testNodeDelay(currentNode, 4000);
            if (delay === 0) {
                Logger.warn('GameAcc', `⚠️ 当前锁定的游戏节点 [${currentNode}] 已完全断联！触发自动故障转移测速...`);
                const fastestNode = await this.findFastestGameNode();
                if (fastestNode && fastestNode.name !== currentNode) await this.lockGameNode(fastestNode.name);
            }
        } catch (err) { Logger.error('GameAcc', '故障转移心跳检测发生异常', err); }
    }

    static async runSilentPeriodicalCheck() {
        try {
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) return;
            const isLocked = SpeedtestState.isLocked('game');
            Logger.info('GameAcc', `🕰️ 触发游戏节点定期静默测速优化检测... (${isLocked ? 'LOCKED' : 'UNLOCK'})`);
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.now) return;
            const currentNode = group.now;
            let currentDelay = await ClashService.testNodeDelay(currentNode, 4000);
            if (currentDelay === 0) currentDelay = 99999;
            const fastestNode = await this.findFastestGameNode();
            if (!fastestNode) return;
            if (isLocked) { Logger.info('GameAcc', `定期检测(LOCKED)：仅更新测速结果 (${fastestNode.name} ${fastestNode.delay}ms)，不切换节点。`); return; }
            if (fastestNode.name === currentNode) { Logger.info('GameAcc', `定期检测：当前节点已是最优，保持不变。`); return; }
            const diff = currentDelay - fastestNode.delay;
            if (diff > 200) { Logger.info('GameAcc', `🎉 发现更优: [${fastestNode.name}] (${fastestNode.delay}ms)，切换。`); await this.lockGameNode(fastestNode.name); }
            else { Logger.info('GameAcc', `虽有更快节点但差值 ${diff}ms <= 200ms，保持稳定不切换。`); }
        } catch (err) { Logger.error('GameAcc', '定期静默测速优化任务异常', err); }
    }

    static stopGameAccMonitor() {
        if (gameAccStartTimeout) { clearTimeout(gameAccStartTimeout); gameAccStartTimeout = null; }
        if (gameAccCheckTimer) { clearInterval(gameAccCheckTimer); gameAccCheckTimer = null; Logger.info('GameAcc', '🛑 停止游戏加速节点状态守护监测进程'); }
        if (silentStartTimeout) { clearTimeout(silentStartTimeout); silentStartTimeout = null; }
        if (silentPeriodicalTimer) { clearInterval(silentPeriodicalTimer); silentPeriodicalTimer = null; Logger.info('GameAcc', '🛑 已注销游戏后台静默测速定时任务'); }
    }

    static startDailyTaskMonitor() {
        if (dailyCheckTimer) return;
        Logger.info('GameAcc', '🕰️ 每日凌晨定时切换任务启动成功');
        dailyCheckTimer = setInterval(async () => {
            const { hour, minute } = this._getBeijingTimeParts();
            if (hour === 4 && minute === 0) {
                if (!dailyCheckDone) {
                    dailyCheckDone = true;
                    const gameMacs = this.readGameDevices();
                    if (gameMacs.length > 0) {
                        const isLocked = SpeedtestState.isLocked('game');
                        Logger.info('GameAcc', `🕰️ 04:00 重测... (${isLocked ? 'LOCKED:仅更新' : 'UNLOCK:切换'})`);
                        try { const fastestNode = await this.findFastestGameNode(); if (fastestNode && !isLocked) await this.lockGameNode(fastestNode.name); }
                        catch (err) { Logger.error('GameAcc', '每日凌晨定时测速切换异常', err); }
                    }
                }
            } else { dailyCheckDone = false; }
        }, 60000);
    }
}

module.exports = GameAccService;