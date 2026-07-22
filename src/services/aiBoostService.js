const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const SshService = require('./sshService');
const PersistenceService = require('./persistenceService');
const SpeedtestState = require('./speedtestState');
const { getBeijingTimeParts } = require('../constants');

let aiBoostCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let silentPeriodicalTimer = null; // 后台定期静默测速定时器
let silentRunning = false; // 静默测速重入锁
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
            ClashService.setFullSpeedtestFlag(true);
            Logger.info('AiBoost', '🔍 开始并发测试 AI 节点延迟，寻找最快节点...');
            const proxiesData = await ClashService.getProxies(6000);
            
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('AiBoost', '未找到 🤖 AI强化 策略组，无法自动寻优');
                return null;
            }
            
            const proxies = proxiesData.proxies || {};
            
            // 递归展开虚拟节点到叶子节点（与前端 /api/nodes 的 getAllLeafNodes 一致）
            const getAllLeafNodes = (nameOrNames, visited = new Set()) => {
                if (Array.isArray(nameOrNames)) {
                    let res = [];
                    for (const n of nameOrNames) {
                        res = res.concat(getAllLeafNodes(n, visited));
                    }
                    return res;
                }
                if (!nameOrNames || visited.has(nameOrNames)) return [];
                visited.add(nameOrNames);
                const p = proxies[nameOrNames];
                if (!p) return [nameOrNames];
                if (p.all && Array.isArray(p.all)) {
                    return getAllLeafNodes(p.all, visited);
                }
                return [nameOrNames];
            };

            const leafNodes = getAllLeafNodes(group.all);
            
            // 过滤：IPLC/IEPL 中继节点，同时纳入香港/新加坡/日本的直連 gRPC 节点（与前端 /api/nodes 一致）
            const filteredNodes = leafNodes.filter(nodeName => {
                const lowerName = nodeName.toLowerCase();
                if (['direct', 'global'].includes(lowerName)) return false;
                const isIPLC = lowerName.includes('iplc') || lowerName.includes('iepl');
                const isHK = lowerName.includes('hk') || lowerName.includes('hongkong') || 
                             lowerName.includes('香港') || lowerName.includes('港');
                const hasAILabel = lowerName.includes('gemini') || lowerName.includes('gpt') || lowerName.includes('ai');
                const isGRPC = lowerName.includes('grpc');
                const isGoodRegion = isHK || 
                    lowerName.includes('sg') || lowerName.includes('singapore') || lowerName.includes('新加坡') ||
                    lowerName.includes('jp') || lowerName.includes('japan') || lowerName.includes('日本') || lowerName.includes('日');
                return (isIPLC && (!isHK || hasAILabel)) || (isGRPC && isGoodRegion);
            });

            if (filteredNodes.length === 0) {
                Logger.warn('AiBoost', '过滤香港节点后无可用的 AI 备选物理节点，退回原自动策略');
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            const results = [];
            // 【硬件防波段】：每节点 2s 间隔，每 5 节点后额外冷却 2s，防止弱机能路由器 CPU 峰值累积
            const NODE_COOLDOWN_MS = 2000;
            const BATCH_SIZE = 5;
            const BATCH_COOLDOWN_MS = 2000;
            for (let i = 0; i < filteredNodes.length; i++) {
                const nodeName = filteredNodes[i];
                const delay = await ClashService.testNodeDelay(nodeName, 2000, 'https://generativelanguage.googleapis.com/');
                results.push({ name: nodeName, delay: delay > 0 ? delay : 99999 });
                if (i < filteredNodes.length - 1) {
                    await new Promise(r => setTimeout(r, NODE_COOLDOWN_MS));
                    if ((i + 1) % BATCH_SIZE === 0) {
                        Logger.debug('AiBoost', `批次冷却: 已完成 ${i + 1}/${filteredNodes.length} 节点，额外 sleep ${BATCH_COOLDOWN_MS}ms 让路由器 CPU 散热`);
                        await new Promise(r => setTimeout(r, BATCH_COOLDOWN_MS));
                    }
                }
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
        } finally {
            ClashService.setFullSpeedtestFlag(false);
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
                if (ClashService.isFullSpeedtestInProgress()) {
                    Logger.debug('AiBoost', '全量测速进行中，跳过本轮心跳');
                    return;
                }
                await this._checkAiNodeHealth();
            }, 600000); // 每 10 分钟轮询
        }, 60000); // 60秒错峰偏置
        Logger.info('AiBoost', '🛡️ AI 强化故障心跳已排程，将在 60 秒后错峰激活 (周期 10 分钟)');

    }

    static async _checkAiNodeHealth() {
        const aiMacs = this.readAiDevices();
        if (aiMacs.length === 0) {
            this.stopAiBoostMonitor();
            return;
        }

        // 重启冷却期：重启或重载后 90s 内不执行检测（给内核就绪充足的缓冲时间）
        const lastRestartTime = SshService.getLastRestartTime?.() || 0;
        const timeSinceLastRestart = Date.now() - lastRestartTime;
        if (timeSinceLastRestart < 90000) {
            Logger.debug('AiBoost', `处于重启避让期，跳过健康心跳 (${Math.floor((90000 - timeSinceLastRestart) / 1000)}s 剩余)`);
            return;
        }

        try {
            const isLocked = SpeedtestState.isLocked('ai');
            const lockedNode = SpeedtestState.getLockedNode('ai');

            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.now) return;

            // 🛡️ 守护状态一致性：如果是锁定状态，且 Clash 当前选中的并不是该锁定物理节点，自动重置并恢复切换
            if (isLocked && lockedNode && group.now !== lockedNode) {
                Logger.info('AiBoost', `🛡️ 检测到 AI 模式锁定节点不一致 (当前: ${group.now}, 预期: ${lockedNode})，正在自动恢复重置...`);
                const restored = await this.lockAiNode(lockedNode);
                if (restored) return; // 恢复成功，本轮检测结束，防止并发冲突
            }

            const currentNode = group.now;
            // 排除自动策略组名称，只有锁死到具体的物理节点才进行可用性保护
            if (['🚀 节点选择', '♻️ 自动选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
                return;
            }
            
            const delay = await ClashService.testNodeDelay(currentNode, 4000, 'https://generativelanguage.googleapis.com/');
            if (delay === 0) {
                Logger.warn('AiBoost', `⚠️ 当前锁定的 AI 节点 [${currentNode}] 已完全断联！请在详情弹窗中手动测速或手动切换节点。`);
            }
        } catch (err) {
            Logger.error('AiBoost', '故障转移心跳检测发生异常', err);
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
    }
}

module.exports = AiBoostService;
