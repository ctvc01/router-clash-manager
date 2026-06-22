const Logger = require('../utils/logger');
const cache = require('../utils/cache');
const SshService = require('./sshService');
const ClashService = require('./clashService');
const RulesEngine = require('./rulesEngine');
const GameAccService = require('./gameAccService');
const AiBoostService = require('./aiBoostService');

class AccelerationService {
    // 启用加速（统一逻辑，支持 'game' 和 'ai' 两种类型）
    static async enableAcceleration(mac, type) {
        const isGame = type === 'game';
        const service = isGame ? GameAccService : AiBoostService;
        const otherService = isGame ? AiBoostService : GameAccService;
        const label = isGame ? 'GameAcc' : 'AiBoost';
        const modeName = isGame ? '游戏加速' : 'AI 强化';
        const otherModeName = isGame ? 'AI 强化' : '游戏加速';

        const macs = service.readAccelerationDevices?.() || service.readGameDevices?.() || service.readAiDevices();
        let otherMacs = otherService.readAccelerationDevices?.() || otherService.readGameDevices?.() || otherService.readAiDevices();

        // 互斥处理
        if (otherMacs.includes(mac)) {
            otherMacs = otherMacs.filter(m => m !== mac);
            otherService.writeAccelerationDevices?.(otherMacs) || otherService.writeGameDevices?.(otherMacs) || otherService.writeAiDevices(otherMacs);
            Logger.info(label, `开启${modeName}：由于设备 ${mac} 原本在${otherModeName}模式，已自动将其从中移除。`);
        }

        // 检查是否需要重启 Clash（只在 MAC 白名单变化时）
        let needsRestart = false;
        const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac');
        const whitelistMacs = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0);

        if (!whitelistMacs.includes(mac)) {
            await SshService.runRemoteCommand(`echo "${mac}" >> /data/ShellCrash/configs/mac`);
            needsRestart = true;
            Logger.info(label, `已将设备 ${mac} 写入 MAC 白名单`);
        }

        // 内存中添加新设备供 RulesEngine 使用（先不写 file）
        if (!macs.includes(mac)) {
            macs.push(mac);
        }

        // 无条件重建/恢复路由器的 iptables 规则以防止其因防火墙重启等原因而失效
        try {
            await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
            Logger.info(label, '已执行 setup_iptables.sh 重建路由器 MAC 劫持规则');
        } catch (e) {
            Logger.warn(label, '更新防火墙规则失败', e.message);
        }

        // Read game+ai devices for RulesEngine
        let gameMacs = GameAccService.readGameDevices();
        let aiMacs = AiBoostService.readAiDevices();
        if (!aiMacs.includes(mac) && type === 'ai') aiMacs = [...aiMacs, mac];
        if (!gameMacs.includes(mac) && type === 'game') gameMacs = [...gameMacs, mac];
        await RulesEngine.updateClashRules(gameMacs, aiMacs);

        // RulesEngine 成功后再持久化到文件
        service.writeAccelerationDevices?.(macs) || service.writeGameDevices?.(macs) || service.writeAiDevices(macs);

        // 异步测速锁定
        this._startAsyncSpeedtest(mac, type, isGame ? 'game' : 'ai');

        // 清理互斥的守护进程
        if (otherMacs.length === 0) {
            otherService.stopAccelerationMonitor?.() || (isGame ? AiBoostService.stopAiBoostMonitor() : GameAccService.stopGameAccMonitor());
        }

        cache.clear('deviceList');
    }

    // 禁用加速
    static async disableAcceleration(mac, type) {
        const isGame = type === 'game';
        const service = isGame ? GameAccService : AiBoostService;
        const label = isGame ? 'GameAcc' : 'AiBoost';
        const modeName = isGame ? '游戏加速' : 'AI 强化';

        let macs = service.readAccelerationDevices?.() || service.readGameDevices?.() || service.readAiDevices();

        if (macs.includes(mac)) {
            macs = macs.filter(m => m !== mac);
            service.writeAccelerationDevices?.(macs) || service.writeGameDevices?.(macs) || service.writeAiDevices(macs);
        }

        // 更新规则（先更新，再判断是否需要清理白名单）
        const gameMacs = GameAccService.readGameDevices();
        const aiMacs = AiBoostService.readAiDevices();
        await RulesEngine.updateClashRules(gameMacs, aiMacs);

        // 检查是否需要从白名单移除（只有 game/ai 都不包含该 MAC 时才移除）
        if (!gameMacs.includes(mac) && !aiMacs.includes(mac)) {
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
                Logger.info(label, `已从路由物理 MAC 白名单清除设备 ${mac} 并重启 ShellCrash！`);
            }
        }

        // 停止守护进程
        const remainingMacs = service.readAccelerationDevices?.() || service.readGameDevices?.() || service.readAiDevices();
        if (remainingMacs.length === 0) {
            service.stopAccelerationMonitor?.() || (isGame ? GameAccService.stopGameAccMonitor() : AiBoostService.stopAiBoostMonitor());
        }

        cache.clear('deviceList');
    }

    // 异步启动测速和守护
    static _startAsyncSpeedtest(mac, type, typeLabel) {
        const isGame = type === 'game';
        const service = isGame ? GameAccService : AiBoostService;
        const label = isGame ? 'GameAcc' : 'AiBoost';
        const modeName = isGame ? '游戏节点' : 'AI 节点';
        const findNodeMethod = isGame ? 'findFastestGameNode' : 'findFastestAiNode';
        const lockNodeMethod = isGame ? 'lockGameNode' : 'lockAiNode';
        const startMonitorMethod = isGame ? 'startGameAccMonitor' : 'startAiBoostMonitor';

        (async () => {
            try {
                const isReady = await ClashService.waitClashReady(25);
                if (isReady) {
                    Logger.info(label, `Clash 核心就绪成功，开始测速锁定最优${modeName}...`);
                    const fastestNode = await service[findNodeMethod]();
                    if (fastestNode) {
                        await service[lockNodeMethod](fastestNode);
                    }
                    service[startMonitorMethod]();
                } else {
                    Logger.warn(label, `Clash 核心在 25 秒内未就绪，跳过自动测速锁定流程。`);
                }
            } catch (monitorErr) {
                Logger.error(label, `异步开启测速与守护任务失败`, monitorErr);
            }
        })();
    }
}

module.exports = AccelerationService;
