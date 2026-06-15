const express = require('express');
const Logger = require('../utils/logger');
const cache = require('../utils/cache');
const Validators = require('../utils/validators');
const SshService = require('../services/sshService');
const ClashService = require('../services/clashService');
const RulesEngine = require('../services/rulesEngine');
const GameAccService = require('../services/gameAccService');
const AiBoostService = require('../services/aiBoostService');

const router = express.Router();

// 1. 获取开启 AI 强化的设备 MAC 列表
router.get('/list', (req, res) => {
    res.json(AiBoostService.readAiDevices());
});

// 2. 开启设备 AI 强化模式
router.post('/enable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        const aiMacs = AiBoostService.readAiDevices();
        let gameMacs = GameAccService.readGameDevices();
        
        // 互斥处理：如果在游戏模式，需从中移除
        if (gameMacs.includes(mac)) {
            gameMacs = gameMacs.filter(m => m !== mac);
            GameAccService.writeGameDevices(gameMacs);
            Logger.info('AiBoost', `开启 AI 强化：由于设备 ${mac} 原本在游戏模式，已自动将其从中移除。`);
        }
        
        if (!aiMacs.includes(mac)) {
            aiMacs.push(mac);
            AiBoostService.writeAiDevices(aiMacs);
        }
        
        // 1. 更新 Clash 规则与 AI 专用策略组
        await RulesEngine.updateClashRules(gameMacs, aiMacs);
        
        // 2. 将设备写入路由器物理 MAC 白名单（防火墙重定向所需）
        const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        const whitelistMacs = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);
            
        if (!whitelistMacs.includes(mac)) {
            await SshService.runRemoteCommand(`echo "${mac}" >> /data/ShellCrash/configs/mac`);
            await SshService.restartShellCrashSecurely();
            Logger.info('AiBoost', `已将设备 ${mac} 物理写入 MAC 白名单并重启 ShellCrash！`);
        }
        
        // 3. 异步任务：等待内核就绪、测速寻优并锁定最优 AI 节点
        (async () => {
            try {
                const isReady = await ClashService.waitClashReady(25);
                if (isReady) {
                    Logger.info('AiBoost', 'Clash 核心就绪成功，开始测速锁定最优 AI 节点...');
                    const fastestNode = await AiBoostService.findFastestAiNode();
                    if (fastestNode) {
                        await AiBoostService.lockAiNode(fastestNode);
                    }
                    AiBoostService.startAiBoostMonitor();
                } else {
                    Logger.warn('AiBoost', 'Clash 核心在 25 秒内未就绪，跳过自动测速锁定流程。');
                }
            } catch (monitorErr) {
                Logger.error('AiBoost', '异步开启 AI 测速与守护任务失败', monitorErr);
            }
        })();
        
        // 如果游戏设备无了，停止游戏守护
        if (gameMacs.length === 0) {
            GameAccService.stopGameAccMonitor();
        }
        
        // 操作成功，清除设备列表的缓存
        cache.clear('deviceList');
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '启用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({ 
            success: false, 
            message: err.message 
        });
    }
});

// 3. 关闭设备 AI 强化模式
router.post('/disable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        let aiMacs = AiBoostService.readAiDevices();
        const gameMacs = GameAccService.readGameDevices();
        
        if (aiMacs.includes(mac)) {
            aiMacs = aiMacs.filter(m => m !== mac);
            AiBoostService.writeAiDevices(aiMacs);
        }
        
        // 1. 同步注销加速规则
        await RulesEngine.updateClashRules(gameMacs, aiMacs);
        
        // 2. 清除路由器上的 MAC 白名单（回滚为直连，由前端自选是否随后切入网页代理）
        const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        const whitelistMacs = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);
            
        if (whitelistMacs.includes(mac)) {
            const updatedMacs = whitelistMacs.filter(m => m !== mac);
            if (updatedMacs.length === 0) {
                await SshService.runRemoteCommand('true > /data/ShellCrash/configs/mac');
            } else {
                await SshService.runRemoteCommand(`printf "${updatedMacs.join('\\n')}\\n" > /data/ShellCrash/configs/mac`);
            }
            await SshService.restartShellCrashSecurely();
            Logger.info('AiBoost', `已从路由物理 MAC 白名单清除设备 ${mac} 并重启 ShellCrash！`);
        }
        
        // 3. 如果没有任何设备处于 AI 模式，停止监控
        const remainingMacs = AiBoostService.readAiDevices();
        if (remainingMacs.length === 0) {
            AiBoostService.stopAiBoostMonitor();
        }
        
        // 操作成功，清除设备列表的缓存
        cache.clear('deviceList');
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '禁用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({ 
            success: false, 
            message: err.message 
        });
    }
});

module.exports = router;
