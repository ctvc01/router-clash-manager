const express = require('express');
const Logger = require('../utils/logger');
const cache = require('../utils/cache');
const Validators = require('../utils/validators');
const SshService = require('../services/sshService');
const GameAccService = require('../services/gameAccService');
const AiBoostService = require('../services/aiBoostService');
const RulesEngine = require('../services/rulesEngine');

const router = express.Router();

// 1. 将设备加入代理白名单 (走 WAF 强校验拦截，清除设备缓存)
router.post('/add', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        
        // 互斥处理：从高级分流模式（游戏/AI）中剔除
        let gameMacs = GameAccService.readGameDevices();
        let aiMacs = AiBoostService.readAiDevices();
        let listChanged = false;
        
        if (gameMacs.includes(mac)) {
            gameMacs = gameMacs.filter(m => m !== mac);
            GameAccService.writeGameDevices(gameMacs);
            listChanged = true;
        }
        if (aiMacs.includes(mac)) {
            aiMacs = aiMacs.filter(m => m !== mac);
            AiBoostService.writeAiDevices(aiMacs);
            listChanged = true;
        }
        
        if (listChanged) {
            const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
            const proxyMacs = whitelistOutput
                .split('\n')
                .map(line => line.trim().toLowerCase())
                .filter(line => line.length > 0);

            await RulesEngine.updateClashRules(gameMacs, aiMacs, proxyMacs);
            if (gameMacs.length === 0) GameAccService.stopGameAccMonitor();
            if (aiMacs.length === 0) AiBoostService.stopAiBoostMonitor();
        }

        const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        const whitelistMacs = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);

        if (whitelistMacs.includes(mac)) {
            return res.json({ status: 'success', message: '设备已在白名单中' });
        }

        // 写入路由器配置文件
        await SshService.runRemoteCommand(`echo "${mac}" >> /data/ShellCrash/configs/mac`);

        // 重新读取白名单并更新规则
        const updatedProxyMacs = [...whitelistMacs, mac];

        await RulesEngine.updateClashRules(gameMacs, aiMacs, updatedProxyMacs);

        // 安全重启防火墙与 Clash 核心
        await SshService.restartShellCrashSecurely();

        // 操作成功，强制清除缓存让前端刷新最新的设备状态
        cache.clear('deviceList');
        res.json({ status: 'success' });
    } catch (err) {
        Logger.error('Whitelist', '添加白名单发生异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({ 
            status: 'error', 
            message: '添加白名单失败', 
            details: err.stderr || err.message 
        });
    }
});

// 2. 将设备从白名单中移出 (走 WAF 强校验拦截，清除设备缓存)
router.post('/remove', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);

        // 互斥处理：从高级分流模式（游戏/AI）中剔除
        let gameMacs = GameAccService.readGameDevices();
        let aiMacs = AiBoostService.readAiDevices();
        let listChanged = false;
        
        if (gameMacs.includes(mac)) {
            gameMacs = gameMacs.filter(m => m !== mac);
            GameAccService.writeGameDevices(gameMacs);
            listChanged = true;
        }
        if (aiMacs.includes(mac)) {
            aiMacs = aiMacs.filter(m => m !== mac);
            AiBoostService.writeAiDevices(aiMacs);
            listChanged = true;
        }
        
        if (listChanged) {
            const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
            const proxyMacs = whitelistOutput
                .split('\n')
                .map(line => line.trim().toLowerCase())
                .filter(line => line.length > 0);

            await RulesEngine.updateClashRules(gameMacs, aiMacs, proxyMacs);
            if (gameMacs.length === 0) GameAccService.stopGameAccMonitor();
            if (aiMacs.length === 0) AiBoostService.stopAiBoostMonitor();
        }

        const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        const whitelistMacs = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);

        if (!whitelistMacs.includes(mac)) {
            return res.json({ status: 'success', message: '设备不在白名单中' });
        }

        const newMacList = whitelistMacs.filter(m => m !== mac);
        const fileContent = newMacList.join('\\n');

        if (newMacList.length === 0) {
            await SshService.runRemoteCommand('true > /data/ShellCrash/configs/mac');
        } else {
            await SshService.runRemoteCommand(`printf "${fileContent}\\n" > /data/ShellCrash/configs/mac`);
        }

        // 重新更新规则（移除后的代理设备列表）
        await RulesEngine.updateClashRules(gameMacs, aiMacs, newMacList);

        // 安全重启防火墙与 Clash 核心
        await SshService.restartShellCrashSecurely();

        // 操作成功，强制清除缓存让前端刷新最新状态
        cache.clear('deviceList');
        res.json({ status: 'success' });
    } catch (err) {
        Logger.error('Whitelist', '移出白名单失败', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({ 
            status: 'error', 
            message: '移出白名单失败', 
            details: err.stderr || err.message 
        });
    }
});

module.exports = router;
