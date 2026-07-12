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

        // 阻止 NAS 宿主机 MAC 加入代理白名单以防断网锁死
        const localMacs = Validators.getLocalMACs();
        if (localMacs.includes(mac)) {
            return res.json({ status: 'success', message: 'NAS 宿主机已自动保护为直连，跳过白名单添加' });
        }

        // 写入路由器配置文件
        await SshService.runRemoteCommand(`echo "${mac}" >> /data/ShellCrash/configs/mac`);

        // 重新读取白名单并更新规则
        const updatedProxyMacs = [...whitelistMacs, mac];

        await RulesEngine.updateClashRules(gameMacs, aiMacs, updatedProxyMacs);

        // 创建透明代理的 iptables 规则
        try {
            // 确保锁定文件存在（解决 iptables 锁定问题）
            await SshService.runRemoteCommand('mkdir -p /var/run && touch /var/run/xtables.lock 2>/dev/null || true');

            // 从 DHCP 租约中获取设备的 IP
            const deviceIP = (await SshService.runRemoteCommand(`grep -i "${mac}" /data/dhcp.leases | awk '{print $3}'`)).trim();
            if (deviceIP && deviceIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                // 添加 HTTP 和 HTTPS 流量重定向到 Clash 代理端口
                await SshService.runRemoteCommand(`iptables -t nat -I PREROUTING -s ${deviceIP} -p tcp --dport 80 -j REDIRECT --to-port 7890 2>/dev/null || true`);
                await SshService.runRemoteCommand(`iptables -t nat -I PREROUTING -s ${deviceIP} -p tcp --dport 443 -j REDIRECT --to-port 7890 2>/dev/null || true`);
                Logger.info('Whitelist', `✓ 为设备 ${deviceIP} (${mac}) 创建了透明代理规则`);
            }
        } catch (err) {
            Logger.warn('Whitelist', '创建透明代理规则失败（非严重错误）', err.message);
        }

        // 安全重启防火墙与 Clash 核心
        // 仅重建 iptables，无需 restart Clash（规则由 RulesEngine 热重载注入）
        await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');

        // 操作成功，强制清除缓存让前端刷新最新的设备状态
        cache.clear('deviceList');
        cache.clear('gatewayStatus');
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
        await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');

        // 操作成功，强制清除缓存让前端刷新最新状态
        cache.clear('deviceList');
        cache.clear('gatewayStatus');
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
