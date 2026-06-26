const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const PersistenceService = require('./persistenceService');
const SpeedtestState = require('./speedtestState');
const { getBeijingTimeParts } = require('../constants');

let aiBoostCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let silentPeriodicalTimer = null; // 后台定期静默测速定时器
let aiBoostStartTimeout = null;   // 心跳启动延时器
let silentStartTimeout = null;     // 静默测速启动延时器

class AiBoostService {
    // 读取已开启 AI 强化的设备 MAC 地址（使用持久化服务）
    static readAiDevices() {
        const data = PersistenceService.readText(config.paths.aiDevices, '');
        return data.split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);
    }

    // 写入开启 AI 强化的设备 MAC 地址（使用持久化服务）
    static writeAiDevices(devices) {
        return PersistenceService.writeText(config.paths.aiDevices, devices.join('\n') + '\n');
    }

    // 寻找当前最快的 AI 节点 (针对 Google API)
    // 返回 { name, delay } 对象，方便延迟差比较
    static async findFastestAiNode() {
        try {
            Logger.info('AiBoost', '🔍 开始并发测试 AI 节点延迟，寻找最快节点...');
            const proxiesData = await ClashService.getProxies(6000);
            
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('AiBoost', '未找到 🤖 AI强化 策略组，无法自动寻优');
                return null;
            }
            
            // 过滤：排除 HK 节点（Gemini 在港不可用）、排除组名（Selector/URLTest）、排除直连
            const filteredNodes = group.all.filter(nodeName => {
                const lowerName = nodeName.toLowerCase();
                return !lowerName.includes('hk') && 
                       !lowerName.includes('hongkong') && 
                       !lowerName.includes('香港') && 
                       !lowerName.includes('港') &&
                       !['direct', 'global'].includes(lowerName) &&
                       !lowerName.includes('选择节点') &&
                       !lowerName.includes('节点选择') &&
                       !lowerName.includes('自动测速') &&
                       !lowerName.includes('自动选择');
            });

            if (filteredNodes.length === 0) {
                Logger.warn('AiBoost', '过滤香港节点后无可用的 AI 备选物理节点，退回原自动策略');
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            const results = [];
            for (const nodeName of filteredNodes) {
                const delay = await ClashService.testNodeDelay(nodeName, 2000, 'https://generativelanguage.googleapis.com/');
                results.push({ name: nodeName, delay: delay > 0 ? delay : 99999 });
            }
            const validResults = results.filter(r => r.delay < 99999);
            if (validResults.length === 0) {
                Logger.warn('AiBoost', `所有 AI 节点测速全部超时，保持当前或退回原节点: ${group.now}`);
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            validResults.sort((a, b) => a.delay - b.delay);
            const best = validResults[0];
            Logger.info('AiBoost', `✅ 测速最优 AI 节点: ${best.name} (${best.delay} ms)`);
            SpeedtestState.updateResult('ai', best);
            return best;
         } catch (err) {
             Logger.error('AiBoost', '寻找最快 AI 节点时发生异常', err);
             return null;
         }
     }

    // 锁定 🤖 AI强化 策略组到特定节点
    static async lockAiNode(nodeName) {
        if (!nodeName) return false;
        try {
            return await ClashService.selectProxyNode('🤖 AI强化', nodeName);
        } catch (err) {
            Logger.error('AiBoost', `锁定 AI 策略组发生异常: ${nodeName}`, err);
            return false;
        }
    }

    // 手动触发：全量测速 + 锁定最优节点（忽略 LOCK/UNLOCK 状态）
    static async findBestAndLock(force) {
        const best = await this.findFastestAiNode();
        if (best) {
            SpeedtestState.updateResult('ai', best);
            if (force || !SpeedtestState.isLocked('ai')) {
                await this.lockAiNode(best.name);
            }
        }
        return best;
    }

    static startAiBoostMonitor() {
        if (aiBoostCheckTimer || aiBoostStartTimeout) return;
        
        // 1. 故障心跳检测：延迟 60 秒启动，每 5 分钟轮询一次
        aiBoostStartTimeout = setTimeout(() => {
            aiBoostStartTimeout = null;
            const aiMacs = this.readAiDevices();
            if (aiMacs.length === 0) return;

            Logger.info('AiBoost', '🛡️ AI 强化故障心跳检测正式启动 (周期 5 分钟)');
            this._checkAiNodeHealth();

            aiBoostCheckTimer = setInterval(async () => {
                await this._checkAiNodeHealth();
            }, 300000); // 每 5 分钟轮询
        }, 60000); // 60秒错峰偏置
        Logger.info('AiBoost', '🛡️ AI 强化故障心跳已排程，将在 60 秒后错峰激活 (周期 5 分钟)');

        // 2. 启动后台定期静默测速优化检测定时器：延迟 5 分钟 (300000ms) 启动，每 30 分钟一次 (1800000ms)
        if (!silentPeriodicalTimer && !silentStartTimeout) {
            silentStartTimeout = setTimeout(() => {
                silentStartTimeout = null;
                const aiMacs = this.readAiDevices();
                if (aiMacs.length === 0) return;

                Logger.info('AiBoost', '🕰️ AI 节点后台静默测速优化任务正式启动 (周期 30 分钟)');
                this.runSilentPeriodicalCheck();

                silentPeriodicalTimer = setInterval(() => this.runSilentPeriodicalCheck(), 1800000);
            }, 300000); // 5分钟错峰偏置
            Logger.info('AiBoost', '🕰️ AI 后台静默测速优化已排程，将在 5 分钟后错峰激活 (周期 30 分钟)');
        }
    }

    // 内部方法：执行单次 AI 节点可用性心跳检测
    static async _checkAiNodeHealth() {
        const aiMacs = this.readAiDevices();
        if (aiMacs.length === 0) {
            this.stopAiBoostMonitor();
            return;
        }

        try {
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.now) return;
            
            const currentNode = group.now;
            // 排除自动策略组名称，只有锁死到具体的物理节点才进行可用性保护
            if (['⚡ AI自动测速', '🚀 节点选择', '♻️ 自动选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
                return;
            }
            
            const delay = await ClashService.testNodeDelay(currentNode, 4000, 'https://generativelanguage.googleapis.com/');
            if (delay === 0) {
                Logger.warn('AiBoost', `⚠️ 当前锁定的 AI 节点 [${currentNode}] 已完全断联！触发自动故障转移测速...`);
                const fastestNode = await this.findFastestAiNode();
                if (fastestNode && fastestNode.name !== currentNode) {
                    await this.lockAiNode(fastestNode.name);
                }
            }
        } catch (err) {
            Logger.error('AiBoost', '故障转移心跳检测发生异常', err);
        }
    }

    // 后台定期静默测速与克制切换
    static async runSilentPeriodicalCheck() {
        try {
            const aiMacs = this.readAiDevices();
            if (aiMacs.length === 0) return;

            const isLocked = SpeedtestState.isLocked('ai');
            Logger.info('AiBoost', `🕰️ 触发 AI 节点定期静默测速优化检测... (${isLocked ? 'LOCKED' : 'UNLOCK'})`);
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.now) return;

            const currentNode = group.now;
            
            // 1. 快速测速当前节点
            let currentDelay = await ClashService.testNodeDelay(currentNode, 4000, 'https://generativelanguage.googleapis.com/');
            if (currentDelay === 0) currentDelay = 99999;

            // 2. 全量测速寻找最优节点（始终执行以更新 lastResult）
            const fastestNode = await this.findFastestAiNode();
            if (!fastestNode) return;

            // LOCKED 状态下只更新结果不切换
            if (isLocked) {
                Logger.info('AiBoost', `定期检测(LOCKED)：仅更新测速结果 (${fastestNode.name} ${fastestNode.delay}ms)，不切换节点。`);
                return;
            }

            if (fastestNode.name === currentNode) {
                Logger.info('AiBoost', `定期检测：当前锁定的 AI 节点 [${currentNode}] (${currentDelay}ms) 已经是最新最优节点，保持不变。`);
                return;
            }

            // 3. 克制切换判断：延迟差距需大于 200ms
            const diff = currentDelay - fastestNode.delay;
            if (diff > 200) {
                Logger.info('AiBoost', `🎉 发现更优 AI 节点: [${fastestNode.name}] (${fastestNode.delay}ms)，比当前节点 [${currentNode}] (${currentDelay}ms) 快了 ${diff}ms (已超出 200ms 门槛)，执行锁定切换。`);
                await this.lockAiNode(fastestNode.name);
            } else {
                Logger.info('AiBoost', `定期检测：虽发现更快节点 [${fastestNode.name}] (${fastestNode.delay}ms)，但相较当前节点 [${currentNode}] (${currentDelay}ms) 优化差值 ${diff}ms <= 200ms，为保持连接稳定性，跳过主动切换。`);
            }
        } catch (err) {
            Logger.error('AiBoost', '定期静默测速优化任务异常', err);
        }
    }

    // 停止 AI 强化守护进程
    static stopAiBoostMonitor() {
        if (aiBoostStartTimeout) {
            clearTimeout(aiBoostStartTimeout);
            aiBoostStartTimeout = null;
        }
        if (aiBoostCheckTimer) {
            clearInterval(aiBoostCheckTimer);
            aiBoostCheckTimer = null;
            Logger.info('AiBoost', '🛑 停止 AI 强化节点状态守护监测进程');
        }
        if (silentStartTimeout) {
            clearTimeout(silentStartTimeout);
            silentStartTimeout = null;
        }
        if (silentPeriodicalTimer) {
            clearInterval(silentPeriodicalTimer);
            silentPeriodicalTimer = null;
            Logger.info('AiBoost', '🛑 已注销 AI 后台静默测速定时任务');
        }
    }

    // 启动每日凌晨 4:00 (UTC+8) 定时测速锁定更新任务
    static startDailyTaskMonitor() {
        if (dailyCheckTimer) return;
        Logger.info('AiBoost', '🕰️ AI 强化每日凌晨定时切换任务启动成功');
        
        dailyCheckTimer = setInterval(async () => {
            const { hour, minute } = getBeijingTimeParts();
            
            if (hour === 4 && minute === 0) {
                if (!dailyCheckDone) {
                    dailyCheckDone = true;
                        const aiMacs = this.readAiDevices();
                        if (aiMacs.length > 0) {
                            const isLocked = SpeedtestState.isLocked('ai');
                            Logger.info('AiBoost', `🕰️ 检测到当前是北京时间 04:00 且有设备开启 AI 强化，自动触发重测... (${isLocked ? 'LOCKED:仅更新' : 'UNLOCK:切换'})`);
                            try {
                                const fastestNode = await this.findFastestAiNode();
                                if (fastestNode && !isLocked) {
                                    await this.lockAiNode(fastestNode.name);
                                }
                            } catch (err) {
                                Logger.error('AiBoost', '每日凌晨定时测速切换异常', err);
                            }
                        }
                }
            } else {
                dailyCheckDone = false;
            }
        }, 60000); // 每分钟轮询
    }
}

module.exports = AiBoostService;
