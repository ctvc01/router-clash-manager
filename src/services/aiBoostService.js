const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const PersistenceService = require('./persistenceService');

let aiBoostCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let silentPeriodicalTimer = null; // 后台定期静默测速定时器

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
            
            // 过滤掉不支持 AI 的香港节点，并排除通用选择节点和直连
            const filteredNodes = group.all.filter(nodeName => {
                const lowerName = nodeName.toLowerCase();
                return !lowerName.includes('hk') && 
                       !lowerName.includes('hongkong') && 
                       !lowerName.includes('香港') && 
                       !lowerName.includes('港') &&
                       !['direct', 'global'].includes(lowerName) &&
                       !lowerName.includes('选择节点') &&
                       !lowerName.includes('节点选择');
            });

            if (filteredNodes.length === 0) {
                Logger.warn('AiBoost', '过滤香港节点后无可用的 AI 备选物理节点，退回原自动策略');
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            const testPromises = filteredNodes.map(async (nodeName) => {
                const delay = await ClashService.testNodeDelay(nodeName, 4000, 'https://generativelanguage.googleapis.com/');
                return { name: nodeName, delay: delay > 0 ? delay : 99999 };
            });
            
            const results = await Promise.all(testPromises);
            const validResults = results.filter(r => r.delay < 99999);
            if (validResults.length === 0) {
                Logger.warn('AiBoost', `所有 AI 节点测速全部超时，保持当前或退回原节点: ${group.now}`);
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            validResults.sort((a, b) => a.delay - b.delay);
            Logger.info('AiBoost', `✅ 测速最优 AI 节点: ${validResults[0].name} (${validResults[0].delay} ms)`);
            return validResults[0];
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

    // 获取北京时间 (UTC+8) 的小时 and 分钟
    static _getBeijingTimeParts() {
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        const hourPart = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        return {
            hour: hourPart ? parseInt(hourPart.value, 10) : 0,
            minute: minutePart ? parseInt(minutePart.value, 10) : 0
        };
    }

    // 启动 AI 强化节点可用性守护进程
    static startAiBoostMonitor() {
        if (aiBoostCheckTimer) return;
        Logger.info('AiBoost', '🛡️ 启动 AI 强化节点状态守护监测进程');
        
        // 1. 每 30 秒进行一次被动故障转移检测，仅在锁定节点不可用时重测
        aiBoostCheckTimer = setInterval(async () => {
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
                if (['⚡ AI自动测速', '🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
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
                Logger.error('AiBoost', '故障转移守护检测发生异常', err);
            }
        }, 30000); // 每 30 秒轮询

        // 2. 启动后台定期静默测速优化检测定时器：每 15 分钟一次 (900000 ms)
        if (!silentPeriodicalTimer) {
            silentPeriodicalTimer = setInterval(() => this.runSilentPeriodicalCheck(), 900000);
            Logger.info('AiBoost', '🕰️ 已激活 AI 节点后台 15 分钟静默测速优化更新任务');
        }
    }

    // 后台定期静默测速与克制切换
    static async runSilentPeriodicalCheck() {
        try {
            const aiMacs = this.readAiDevices();
            if (aiMacs.length === 0) return;

            Logger.info('AiBoost', '🕰️ 触发 AI 节点定期静默测速优化检测...');
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🤖 AI强化'];
            if (!group || !group.now) return;

            const currentNode = group.now;
            
            // 1. 快速测速当前节点
            let currentDelay = await ClashService.testNodeDelay(currentNode, 4000, 'https://generativelanguage.googleapis.com/');
            if (currentDelay === 0) currentDelay = 99999; // 完全断开时视为无穷大

            // 2. 并发测速寻找所有物理节点中的最快节点
            const fastestNode = await this.findFastestAiNode();
            if (!fastestNode) return;

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
        if (aiBoostCheckTimer) {
            clearInterval(aiBoostCheckTimer);
            aiBoostCheckTimer = null;
            Logger.info('AiBoost', '🛑 停止 AI 强化节点状态守护监测进程');
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
            const { hour, minute } = this._getBeijingTimeParts();
            
            if (hour === 4 && minute === 0) {
                if (!dailyCheckDone) {
                    dailyCheckDone = true;
                    const aiMacs = this.readAiDevices();
                    if (aiMacs.length > 0) {
                        Logger.info('AiBoost', '🕰️ 检测到当前是北京时间 04:00 且有设备开启 AI 强化，自动触发重测与切换...');
                        try {
                            const fastestNode = await this.findFastestAiNode();
                            if (fastestNode) {
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
