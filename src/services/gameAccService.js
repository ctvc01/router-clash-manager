const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const PersistenceService = require('./persistenceService');

let gameAccCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let silentPeriodicalTimer = null; // 后台定期静默测速定时器
let gameAccStartTimeout = null;   // 心跳启动延时器
let silentStartTimeout = null;     // 静默测速启动延时器

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
    // 返回 { name, delay } 对象，方便延迟差比较
    static async findFastestGameNode() {
        try {
            Logger.info('GameAcc', '🔍 开始并发测试游戏节点延迟，寻找最快节点...');
            const proxiesData = await ClashService.getProxies(6000);
            
            const group = proxiesData.proxies['⚡ 游戏自动测速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 ⚡ 游戏自动测速 组，无法自动寻优');
                return null;
            }
            
            const results = [];
            for (const nodeName of group.all) {
                const delay = await ClashService.testNodeDelay(nodeName, 2000);
                results.push({ name: nodeName, delay: delay > 0 ? delay : 99999 });
            }
            const validResults = results.filter(r => r.delay < 99999);
            if (validResults.length === 0) {
                Logger.warn('GameAcc', `所有游戏节点测速全部超时，保持当前或退回原节点: ${group.now}`);
                return group.now ? { name: group.now, delay: 99999 } : null;
            }
            
            validResults.sort((a, b) => a.delay - b.delay);
            Logger.info('GameAcc', `✅ 测速最优节点: ${validResults[0].name} (${validResults[0].delay} ms)`);
            return validResults[0];
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

    // 启动游戏加速节点可用性守护进程 (错峰调度)
    static startGameAccMonitor() {
        if (gameAccCheckTimer || gameAccStartTimeout) return;
        
        // 1. 故障心跳检测：延迟 120 秒 (2分钟) 启动，每 5 分钟轮询一次
        gameAccStartTimeout = setTimeout(() => {
            gameAccStartTimeout = null;
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) return;

            Logger.info('GameAcc', '🛡️ 游戏加速故障心跳检测正式启动 (周期 5 分钟)');
            this._checkGameNodeHealth();

            gameAccCheckTimer = setInterval(async () => {
                await this._checkGameNodeHealth();
            }, 300000); // 每 5 分钟轮询
        }, 120000); // 120秒错峰偏置
        Logger.info('GameAcc', '🛡️ 游戏加速故障心跳已排程，将在 120 秒后错峰激活 (周期 5 分钟)');

        // 2. 启动后台定期静默测速优化检测定时器：延迟 8 分钟 (480000ms) 启动，每 30 分钟一次 (1800000ms)
        if (!silentPeriodicalTimer && !silentStartTimeout) {
            silentStartTimeout = setTimeout(() => {
                silentStartTimeout = null;
                const gameMacs = this.readGameDevices();
                if (gameMacs.length === 0) return;

                Logger.info('GameAcc', '🕰️ 游戏节点后台静默测速优化任务正式启动 (周期 30 分钟)');
                this.runSilentPeriodicalCheck();

                silentPeriodicalTimer = setInterval(() => this.runSilentPeriodicalCheck(), 1800000);
            }, 480000); // 8分钟错峰偏置
            Logger.info('GameAcc', '🕰️ 游戏后台静默测速优化已排程，将在 8 分钟后错峰激活 (周期 30 分钟)');
        }
    }

    // 内部方法：执行单次游戏节点可用性心跳检测
    static async _checkGameNodeHealth() {
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
                if (fastestNode && fastestNode.name !== currentNode) {
                    await this.lockGameNode(fastestNode.name);
                }
            }
        } catch (err) {
            Logger.error('GameAcc', '故障转移心跳检测发生异常', err);
        }
    }

    // 后台定期静默测速与克制切换
    static async runSilentPeriodicalCheck() {
        try {
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) return;

            Logger.info('GameAcc', '🕰️ 触发游戏节点定期静默测速优化检测...');
            const proxiesData = await ClashService.getProxies();
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.now) return;

            const currentNode = group.now;
            
            // 1. 快速测速当前节点
            let currentDelay = await ClashService.testNodeDelay(currentNode, 4000);
            if (currentDelay === 0) currentDelay = 99999; // 完全断开时视为无穷大

            // 2. 并发测速寻找所有物理节点中的最快节点
            const fastestNode = await this.findFastestGameNode();
            if (!fastestNode) return;

            if (fastestNode.name === currentNode) {
                Logger.info('GameAcc', `定期检测：当前锁定的游戏节点 [${currentNode}] (${currentDelay}ms) 已经是最新最优节点，保持不变。`);
                return;
            }

            // 3. 克制切换判断：延迟差距需大于 200ms
            const diff = currentDelay - fastestNode.delay;
            if (diff > 200) {
                Logger.info('GameAcc', `🎉 发现更优游戏节点: [${fastestNode.name}] (${fastestNode.delay}ms)，比当前节点 [${currentNode}] (${currentDelay}ms) 快了 ${diff}ms (已超出 200ms 门槛)，执行锁定切换。`);
                await this.lockGameNode(fastestNode.name);
            } else {
                Logger.info('GameAcc', `定期检测：虽发现更快游戏节点 [${fastestNode.name}] (${fastestNode.delay}ms)，但相较当前节点 [${currentNode}] (${currentDelay}ms) 优化差值 ${diff}ms <= 200ms，为保持连接稳定性，跳过主动切换。`);
            }
        } catch (err) {
            Logger.error('GameAcc', '定期静默测速优化任务异常', err);
        }
    }

    // 停止游戏加速守护进程
    static stopGameAccMonitor() {
        if (gameAccStartTimeout) {
            clearTimeout(gameAccStartTimeout);
            gameAccStartTimeout = null;
        }
        if (gameAccCheckTimer) {
            clearInterval(gameAccCheckTimer);
            gameAccCheckTimer = null;
            Logger.info('GameAcc', '🛑 停止游戏加速节点状态守护监测进程');
        }
        if (silentStartTimeout) {
            clearTimeout(silentStartTimeout);
            silentStartTimeout = null;
        }
        if (silentPeriodicalTimer) {
            clearInterval(silentPeriodicalTimer);
            silentPeriodicalTimer = null;
            Logger.info('GameAcc', '🛑 已注销游戏后台静默测速定时任务');
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
                                await this.lockGameNode(fastestNode.name);
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
