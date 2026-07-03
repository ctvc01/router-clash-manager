const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const SshService = require('./sshService');
const PersistenceService = require('./persistenceService');
const SpeedtestState = require('./speedtestState');
const { getBeijingTimeParts } = require('../constants');

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
            Logger.info('GameAcc', '🔍 3-采样 Nintendo CDN测速 日本加权 gRPC惩罚...');
            const proxiesData = await ClashService.getProxies(6000);
            const group = proxiesData.proxies['⚡ 游戏自动测速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 ⚡ 游戏自动测速 组，无法自动寻优');
                return null;
            }
            const NODE_SAMPLES = 3;
            const TIMEOUT_MS = 3000;
            const TEST_URL = 'http://ctest.cdn.nintendo.net/';
            
            const results = [];
            for (const nodeName of group.all) {
                let successCount = 0, totalDelay = 0;
                let isDead = false;
                for (let i = 0; i < NODE_SAMPLES; i++) {
                    const delay = await ClashService.testNodeDelay(nodeName, TIMEOUT_MS, TEST_URL);
                    if (delay > 0) { 
                        successCount++; 
                        totalDelay += delay; 
                    } else {
                        if (i === 0) {
                            isDead = true;
                            break;
                        }
                    }
                    if (i < NODE_SAMPLES - 1) await new Promise(r => setTimeout(r, 200));
                }
                const lossRate = isDead ? 1.0 : (NODE_SAMPLES - successCount) / NODE_SAMPLES;
                const avgDelay = (!isDead && successCount > 0) ? Math.round(totalDelay / successCount) : 99999;
                const lowerName = nodeName.toLowerCase();
                const isJapan = lowerName.includes('japan') || lowerName.includes('日本') || lowerName.includes('jp');
                const isTaiwan = lowerName.includes('taiwan') || lowerName.includes('台灣') || lowerName.includes('台湾') || lowerName.includes('tw');
                const isKorea = lowerName.includes('korea') || lowerName.includes('韩国') || lowerName.includes('kr');
                const isGRPC = lowerName.includes('grpc');
                let weight = 1.0;
                if (isJapan) weight = 0.75; else if (isTaiwan) weight = 0.85; else if (isKorea) weight = 0.90;
                if (isGRPC && !isJapan) weight *= 1.15;
                const weightedDelay = (!isDead && successCount > 0) ? Math.round(avgDelay * weight) : 99999;
                results.push({ 
                    name: nodeName, 
                    delay: weightedDelay, 
                    rawDelay: isDead ? -1 : avgDelay, 
                    loss: lossRate, 
                    samples: isDead ? 0 : successCount, 
                    region: isJapan ? 'JP' : (isTaiwan ? 'TW' : (isKorea ? 'KR' : 'OTHER')), 
                    isGRPC,
                    timestamp: Date.now()
                });
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
        if (!this._healthFailCounts) this._healthFailCounts = {};
        const gameMacs = this.readGameDevices();
        if (gameMacs.length === 0) { this.stopGameAccMonitor(); return; }

        // 重启冷却期：重启或重载后 90s 内不执行检测（给内核就绪充足的缓冲时间）
        const lastRestartTime = SshService.getLastRestartTime?.() || 0;
        const timeSinceLastRestart = Date.now() - lastRestartTime;
        if (timeSinceLastRestart < 90000) {
            Logger.debug('GameAcc', `处于重启避让期，跳过健康心跳 (${Math.floor((90000 - timeSinceLastRestart) / 1000)}s 剩余)`);
            return;
        }

        try {
            const isLocked = SpeedtestState.isLocked('game');
            const lockedNode = SpeedtestState.getLockedNode('game');

            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.now) return;

            // 🛡️ 守护状态一致性：如果是锁定状态，且 Clash 当前选中的并不是该锁定物理节点，自动重置并恢复切换
            if (isLocked && lockedNode && group.now !== lockedNode) {
                Logger.info('GameAcc', `🛡️ 检测到游戏模式锁定节点不一致 (当前: ${group.now}, 预期: ${lockedNode})，正在自动恢复重置...`);
                const restored = await this.lockGameNode(lockedNode);
                if (restored) return; // 恢复成功，本轮检测结束
            }

            const currentNode = group.now;
            if (['⚡ 游戏自动测速', '🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
                this._healthFailCounts[currentNode] = 0;
                return;
            }
            const delay = await ClashService.testNodeDelay(currentNode, 6000);
            if (delay === 0) {
                this._healthFailCounts[currentNode] = (this._healthFailCounts[currentNode] || 0) + 1;
                if (this._healthFailCounts[currentNode] >= 2) {
                    Logger.warn('GameAcc', `⚠️ 游戏节点 [${currentNode}] 连续${this._healthFailCounts[currentNode]}次断联！触发故障转移...`);
                    const fastestNode = await this.findFastestGameNode();
                    if (fastestNode && fastestNode.name !== currentNode) {
                        await this.lockGameNode(fastestNode.name);
                        if (SpeedtestState.isLocked('game')) {
                            SpeedtestState.setLockedNode('game', fastestNode.name);
                        }
                    }
                    this._healthFailCounts[currentNode] = 0;
                } else {
                    Logger.debug('GameAcc', `游戏节点 [${currentNode}] 单次测速超时 (${this._healthFailCounts[currentNode]}/2)`);
                }
            } else {
                this._healthFailCounts[currentNode] = 0;
                try {
                    let successCount = 1;
                    let totalDelay = delay;
                    const NODE_SAMPLES = 3;
                    const TEST_URL = 'http://ctest.cdn.nintendo.net/';
                    for (let i = 1; i < NODE_SAMPLES; i++) {
                        const d = await ClashService.testNodeDelay(currentNode, 3000, TEST_URL);
                        if (d > 0) {
                            successCount++;
                            totalDelay += d;
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                    const lossRate = (NODE_SAMPLES - successCount) / NODE_SAMPLES;
                    const avgDelay = Math.round(totalDelay / successCount);
                    SpeedtestState.updateResult('game', {
                        name: currentNode,
                        delay: avgDelay,
                        loss: lossRate,
                        samples: successCount
                    });
                } catch (e) {
                    Logger.debug('GameAcc', '心跳增量测速刷新失败', e);
                }
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
            const { hour, minute } = getBeijingTimeParts();
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