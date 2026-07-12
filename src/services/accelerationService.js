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
        
        const Validators = require('../utils/validators');
        const localMacs = Validators.getLocalMACs();
        if (localMacs.includes(mac.toLowerCase())) {
            Logger.warn(label, `已阻断为 NAS 宿主机设备 ${mac} 启用 ${modeName}，强制保持直连。`);
            return false;
        }

        let otherMacs = otherService.readAccelerationDevices?.() || otherService.readGameDevices?.() || otherService.readAiDevices();

        // 互斥处理
        if (otherMacs.includes(mac)) {
            otherMacs = otherMacs.filter(m => m !== mac);
            otherService.writeAccelerationDevices?.(otherMacs) || otherService.writeGameDevices?.(otherMacs) || otherService.writeAiDevices(otherMacs);
            Logger.info(label, `开启${modeName}：由于设备 ${mac} 原本在${otherModeName}模式，已自动将其从中移除。`);
        }


        // 内存中添加新设备供 RulesEngine 使用（先不写 file）
        if (!macs.includes(mac)) {
            macs.push(mac);
        }

        // 先注入规则，成功后再重建 iptables（避免规则失败时流量已被劫持但无正确规则）
        let gameMacs = GameAccService.readGameDevices();
        let aiMacs = AiBoostService.readAiDevices();
        if (!aiMacs.includes(mac) && type === 'ai') aiMacs = [...aiMacs, mac];
        if (!gameMacs.includes(mac) && type === 'game') gameMacs = [...gameMacs, mac];
        await RulesEngine.updateClashRules(gameMacs, aiMacs);

        // 推送 AI 设备白名单（用于 QUIC 阻断）
        let aiMacsWriteCmd = '';
        try {
            let currentAiMacs = AiBoostService.readAiDevices();
            if (!currentAiMacs.includes(mac) && type === 'ai') currentAiMacs = [...currentAiMacs, mac];
            const aiMacsStr = currentAiMacs.join('\\n');
            aiMacsWriteCmd = `printf "${aiMacsStr}\\n" > /data/ShellCrash/configs/ai_devices; `;
        } catch (e) {
            Logger.warn(label, '推送 AI 设备白名单失败', e.message);
        }

       // 批处理：MAC写入 + AI设备 + iptables + QUIC阻断 合并为一次 SSH
        try {
            const macWriteCmd = `grep -q "^${mac}$" /data/ShellCrash/configs/mac || echo "${mac}" >> /data/ShellCrash/configs/mac; `;
            await SshService.runRemoteCommand(
                `${macWriteCmd}${aiMacsWriteCmd}sh /data/ShellCrash/setup_iptables.sh`
            );
            Logger.info(label, '已执行 iptables 规则重建 (批处理)');
        } catch (e) {
            Logger.warn(label, 'TCP 劫持规则重建失败', e.message);
        }

        // RulesEngine 成功后再持久化到文件
        service.writeAccelerationDevices?.(macs) || service.writeGameDevices?.(macs) || service.writeAiDevices(macs);

        // 异步测速锁定
        this._startAsyncSpeedtest(mac, type, isGame ? 'game' : 'ai');

        // 清理互斥的守护进程
        if (otherMacs.length === 0) {
            otherService.stopAccelerationMonitor?.() || (isGame ? AiBoostService.stopAiBoostMonitor() : GameAccService.stopGameAccMonitor());
        }

        cache.clear('deviceList');
        cache.clear('gatewayStatus');
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

        // 原子性从白名单移除并重建规则 (批处理)
        try {
            let cmd = '';
            if (!gameMacs.includes(mac) && !aiMacs.includes(mac)) {
                cmd += `grep -vi "^${mac}$" /data/ShellCrash/configs/mac > /tmp/mac_clean.tmp && mv /tmp/mac_clean.tmp /data/ShellCrash/configs/mac; `;
            }
            const aiMacsStr = aiMacs.join('\\n');
            cmd += `printf "${aiMacsStr}\\n" > /data/ShellCrash/configs/ai_devices; `;
            cmd += `sh /data/ShellCrash/setup_iptables.sh`;
            
            await SshService.runRemoteCommand(cmd);
            Logger.info(label, '已批量执行 MAC清理 + AI列表推送 + 规则重建');
        } catch (e) {
            Logger.warn(label, '执行 MAC/劫持规则批量重建失败', e.message);
        }

        // 停止守护进程
        const remainingMacs = service.readAccelerationDevices?.() || service.readGameDevices?.() || service.readAiDevices();
        if (remainingMacs.length === 0) {
            service.stopAccelerationMonitor?.() || (isGame ? GameAccService.stopGameAccMonitor() : AiBoostService.stopAiBoostMonitor());
        }

        cache.clear('deviceList');
        cache.clear('gatewayStatus');
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
                        await service[lockNodeMethod](fastestNode.name);
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
