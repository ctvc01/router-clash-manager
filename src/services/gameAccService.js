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
let silentRunning = false; // 静默测速重入锁
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
            ClashService.setFullSpeedtestFlag(true);
            Logger.info('GameAcc', '🔍 3-采样 Nintendo CDN测速 日/新/韩/台加权 gRPC惩罚...');
            const proxiesData = await ClashService.getProxies(6000);
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 🎮 游戏加速 组，无法自动寻优');
                return null;
            }
            // 过滤掉策略组名称（节点选择、DIRECT 等），仅保留物理节点
            const physicalNodes = group.all.filter(name => {
                const lower = name.toLowerCase();
                return !['direct', 'global', 'rejection'].includes(lower) &&
                      !lower.includes('节点选择') &&
                      !lower.includes('选择节点') &&
                      !lower.includes('自动测速');
            });
            if (physicalNodes.length === 0) {
                Logger.warn('GameAcc', '🎮 游戏加速 组中无可用物理节点，跳过测速');
                return null;
            }
            const NODE_SAMPLES = 2;
            const TIMEOUT_MS = 3000;
            const TEST_URL = 'http://ctest.cdn.nintendo.net/';
           
           const results = [];
           for (const nodeName of physicalNodes) {
               let successCount = 0, totalDelay = 0;
               for (let i = 0; i < NODE_SAMPLES; i++) {
                  const delay = await ClashService.testNodeDelay(nodeName, TIMEOUT_MS, TEST_URL);
                   if (delay > 0) { successCount++; totalDelay += delay; }
                  if (i < NODE_SAMPLES - 1) await new Promise(r => setTimeout(r, 200));
               }
                const lossRate = (NODE_SAMPLES - successCount) / NODE_SAMPLES;
                const avgDelay = successCount > 0 ? Math.round(totalDelay / successCount) : 99999;
               const lowerName = nodeName.toLowerCase();
               const isJapan = lowerName.includes('japan') || lowerName.includes('日本') || lowerName.includes('jp');
               const isTaiwan = lowerName.includes('taiwan') || lowerName.includes('台灣') || lowerName.includes('台湾') || lowerName.includes('tw');
               const isKorea = lowerName.includes('korea') || lowerName.includes('韩国') || lowerName.includes('kr');
               const isSingapore = lowerName.includes('singapore') || lowerName.includes('新加坡') || lowerName.includes('sg');
               const isGRPC = lowerName.includes('grpc');
               let weight = 1.0;
               if (isJapan) weight = 0.75; else if (isTaiwan) weight = 0.85; else if (isSingapore) weight = 0.88; else if (isKorea) weight = 0.90;
               if (isGRPC && !isJapan) weight *= 1.15;
                const weightedDelay = successCount > 0 ? Math.round(avgDelay * weight) : 99999;
               results.push({ 
                  name: nodeName, 
                  delay: weightedDelay, 
                   rawDelay: avgDelay, 
                  loss: lossRate, 
                   samples: successCount, 
                  region: isJapan ? 'JP' : (isTaiwan ? 'TW' : (isSingapore ? 'SG' : (isKorea ? 'KR' : 'OTHER'))), 
                  isGRPC,
                  timestamp: Date.now()
                });
                
                // 增量更新 per-node 结果，供前端实时展示丢包率
                SpeedtestState.updateGamePerNodeResults([...results]);
                
                // 【硬件防波段】：每次节点测速后强制防抖间隔，防止路由器 CPU 瞬间冲高
                await new Promise(r => setTimeout(r, 500));
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
        finally { ClashService.setFullSpeedtestFlag(false); }
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
            gameAccCheckTimer = setInterval(async () => {
                if (ClashService.isFullSpeedtestInProgress()) {
                    Logger.debug('GameAcc', '全量测速进行中，跳过本轮心跳');
                    return;
                }
                await this._checkGameNodeHealth();
            }, 600000);
        }, 120000);
        Logger.info('GameAcc', '🛡️ 游戏加速故障心跳已排程，将在 120 秒后错峰激活 (周期 10 分钟)');
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
            if (['🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
                this._healthFailCounts[currentNode] = 0;
                return;
            }
            const delay = await ClashService.testNodeDelay(currentNode, 6000);
            if (delay === 0) {
                this._healthFailCounts[currentNode] = (this._healthFailCounts[currentNode] || 0) + 1;
                if (this._healthFailCounts[currentNode] >= 2) {
                    Logger.warn('GameAcc', `⚠️ 当前锁定的游戏节点 [${currentNode}] 连续${this._healthFailCounts[currentNode]}次断联！请在详情弹窗中手动测速/重新锁定新节点。`);
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

    static stopGameAccMonitor() {
        if (gameAccStartTimeout) { clearTimeout(gameAccStartTimeout); gameAccStartTimeout = null; }
        if (gameAccCheckTimer) { clearInterval(gameAccCheckTimer); gameAccCheckTimer = null; Logger.info('GameAcc', '🛑 停止游戏加速节点状态守护监测进程'); }
    }
}

module.exports = GameAccService;
