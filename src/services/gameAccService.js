const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const PersistenceService = require('./persistenceService');

let gameAccCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;

class GameAccService {
    // 读取已开启加速的设备 MAC 地址（使用持久化服务）
    static readGameDevices() {
        const data = PersistenceService.readText(config.paths.gameDevices, '');
        return data.split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);
    }

    // 写入开启加速的设备 MAC 地址（使用持久化服务）
    static writeGameDevices(devices) {
        return PersistenceService.writeText(config.paths.gameDevices, devices.join('\n') + '\n');
    }

    // 寻找当前最快的游戏节点
    static async findFastestGameNode() {
        try {
            Logger.info('GameAcc', '🔍 开始并发测试游戏节点延迟，寻找最快节点...');
            const proxiesData = await ClashService.getProxies(6000);
            
            const group = proxiesData.proxies['⚡ 游戏自动测速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 ⚡ 游戏自动测速 组，无法自动寻优');
                return null;
            }
            
            const testPromises = group.all.map(async (nodeName) => {
                const delay = await ClashService.testNodeDelay(nodeName, 4000);
                return { name: nodeName, delay: delay > 0 ? delay : 99999 };
            });
            
            const results = await Promise.all(testPromises);
            const validResults = results.filter(r => r.delay < 99999);
            if (validResults.length === 0) {
                Logger.warn('GameAcc', `所有游戏节点测速全部超时，保持当前或退回原节点: ${group.now}`);
                return group.now || null;
            }
            
            validResults.sort((a, b) => a.delay - b.delay);
            Logger.info('GameAcc', `✅ 测速最优节点: ${validResults[0].name} (${validResults[0].delay} ms)`);
            return validResults[0].name;
         } catch (err) {
             Logger.error('GameAcc', '寻找最快节点时发生异常', err);
             return null;
         }
    }

    // 锁定 🎮 游戏加速 策略组到特定节点
    static async lockGameNode(nodeName) {
        if (!nodeName) return false;
        try {
            return await ClashService.selectProxyNode('🎮 游戏加速', nodeName);
        } catch (err) {
            Logger.error('GameAcc', `锁定游戏策略组发生异常: ${nodeName}`, err);
            return false;
        }
    }

    // 获取北京时间 (UTC+8)
    // 获取北京时间 (UTC+8) 的小时和分钟
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

    // 启动游戏加速节点可用性守护进程
    static startGameAccMonitor() {
        if (gameAccCheckTimer) return;
        Logger.info('GameAcc', '🛡️ 启动游戏加速节点状态守护监测进程');
        
        gameAccCheckTimer = setInterval(async () => {
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) {
                this.stopGameAccMonitor();
                return;
            }
            
            try {
                const proxiesData = await ClashService.getProxies();
                const group = proxiesData.proxies['🎮 游戏加速'];
                if (!group || !group.now) return;
                
                const currentNode = group.now;
                // 排除自动策略组名称，只有锁死到具体的物理节点才进行可用性保护
                if (['⚡ 游戏自动测速', '🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
                    return;
                }
                
                const delay = await ClashService.testNodeDelay(currentNode, 4000);
                if (delay === 0) {
                    Logger.warn('GameAcc', `⚠️ 当前锁定的游戏节点 [${currentNode}] 已完全断联！触发自动故障转移测速...`);
                    const fastestNode = await this.findFastestGameNode();
                    if (fastestNode && fastestNode !== currentNode) {
                        await this.lockGameNode(fastestNode);
                    }
                }
            } catch (err) {
                Logger.error('GameAcc', '故障转移守护检测发生异常', err);
            }
        }, 30000); // 每 30 秒轮询
    }

    // 停止游戏加速守护进程
    static stopGameAccMonitor() {
        if (gameAccCheckTimer) {
            clearInterval(gameAccCheckTimer);
            gameAccCheckTimer = null;
            Logger.info('GameAcc', '🛑 停止游戏加速节点状态守护监测进程');
        }
    }

    // 启动每日凌晨 4:00 (UTC+8) 定时测速锁定更新任务
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
                        Logger.info('GameAcc', '🕰️ 检测到当前是北京时间 04:00 且有设备开启加速，自动触发重测与切换...');
                        try {
                            const fastestNode = await this.findFastestGameNode();
                            if (fastestNode) {
                                await this.lockGameNode(fastestNode);
                            }
                        } catch (err) {
                            Logger.error('GameAcc', '每日凌晨定时测速切换异常', err);
                        }
                    }
                }
            } else {
                dailyCheckDone = false;
            }
        }, 60000); // 每分钟轮询
    }
}

module.exports = GameAccService;
