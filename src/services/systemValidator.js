const Logger = require('../utils/logger');
const SshService = require('./sshService');
const GameAccService = require('./gameAccService');
const AiBoostService = require('./aiBoostService');
const RulesEngine = require('./rulesEngine');

class SystemValidator {
    // 启动时的完整系统检查
    static async validateOnStartup() {
        Logger.info('Validator', '开始系统完整性检查...');

        try {
            // 1. 获取DHCP租约
            const dhcpLeases = await this.getDhcpLeases();
            Logger.debug('Validator', `✓ DHCP租约读取: ${Object.keys(dhcpLeases).length}条记录`);

            // 2. 验证游戏设备
            await this.validateGameDevices(dhcpLeases);

            // 3. 验证AI设备
            await this.validateAiDevices(dhcpLeases);

            // 4. 验证代理白名单
            await this.validateProxyWhitelist(dhcpLeases);

            // 5. 验证Clash配置中的规则注入
            await this.validateClashConfiguration();

            Logger.info('Validator', '✅ 系统完整性检查通过');
        } catch (err) {
            Logger.error('Validator', '系统检查发现问题', err);
            throw err;
        }
    }

    // 获取DHCP租约
    static async getDhcpLeases() {
        try {
            const leasesOutput = await SshService.runRemoteCommand('cat /tmp/dhcp.leases');
            const dhcpLeases = {};
            const leaseLines = leasesOutput.split('\n');
            for (const line of leaseLines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                    dhcpLeases[parts[1].toLowerCase()] = parts[2];
                }
            }
            return dhcpLeases;
        } catch (err) {
            Logger.error('Validator', '获取DHCP租约失败', err);
            return {};
        }
    }

    // 验证游戏设备列表
    static async validateGameDevices(dhcpLeases) {
        const gameDevices = GameAccService.readGameDevices();
        const invalidMacs = gameDevices.filter(mac => !dhcpLeases[mac.toLowerCase()]);

        if (invalidMacs.length === 0) {
            Logger.debug('Validator', `✓ 游戏设备${gameDevices.length}个，全部有效`);
            return;
        }

        Logger.warn('Validator', `⚠️ 检测到${invalidMacs.length}个无效游戏设备: ${invalidMacs.join(', ')}`);

        // 自动清理无效设备
        const validMacs = gameDevices.filter(mac => dhcpLeases[mac.toLowerCase()]);
        GameAccService.writeGameDevices(validMacs);
        Logger.info('Validator', `✓ 已自动清理，保留${validMacs.length}个有效设备`);
    }

    // 验证AI设备列表
    static async validateAiDevices(dhcpLeases) {
        const aiDevices = AiBoostService.readAiDevices();
        const invalidMacs = aiDevices.filter(mac => !dhcpLeases[mac.toLowerCase()]);

        if (invalidMacs.length === 0) {
            Logger.debug('Validator', `✓ AI设备${aiDevices.length}个，全部有效`);
            return;
        }

        Logger.warn('Validator', `⚠️ 检测到${invalidMacs.length}个无效AI设备: ${invalidMacs.join(', ')}`);

        // 自动清理无效设备
        const validMacs = aiDevices.filter(mac => dhcpLeases[mac.toLowerCase()]);
        AiBoostService.writeAiDevices(validMacs);
        Logger.info('Validator', `✓ 已自动清理，保留${validMacs.length}个有效设备`);
    }

    // 验证代理白名单
    static async validateProxyWhitelist(dhcpLeases) {
        try {
            const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac').catch(() => '');
            const proxyMacs = whitelistOutput
                .split('\n')
                .map(line => line.trim().toLowerCase())
                .filter(line => line.length > 0);

            if (proxyMacs.length === 0) {
                Logger.debug('Validator', '✓ 代理白名单为空');
                return { macs: [], valid: 0, invalid: 0 };
            }

            const invalidMacs = proxyMacs.filter(mac => !dhcpLeases[mac]);

            if (invalidMacs.length > 0) {
                Logger.warn('Validator', `⚠️ 代理白名单中有${invalidMacs.length}个无效设备: ${invalidMacs.join(', ')}`);
                // 这里不自动清理，因为可能是临时离线的设备
            }

            Logger.debug('Validator', `✓ 代理设备${proxyMacs.length}个（有效: ${proxyMacs.length - invalidMacs.length}）`);
            return { macs: proxyMacs, valid: proxyMacs.length - invalidMacs.length, invalid: invalidMacs.length };
        } catch (err) {
            Logger.warn('Validator', '读取代理白名单失败', err);
            return { macs: [], valid: 0, invalid: 0 };
        }
    }

    // 验证Clash配置中的规则注入
    static async validateClashConfiguration() {
        try {
            const { ROUTER_PATHS } = require('../constants');
            const config = await SshService.runRemoteCommand(`cat ${ROUTER_PATHS.CLASH_CONFIG}`);

            const hasAiRules = config.includes('# === AI RULES START ===');

            const gameDevices = GameAccService.readGameDevices();
            const aiDevices = AiBoostService.readAiDevices();

            // 检查白名单
            const whitelistOutput = await SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac').catch(() => '');
            const proxyMacs = whitelistOutput
                .split('\n')
                .map(line => line.trim().toLowerCase())
                .filter(line => line.length > 0);

            // 验证规则匹配
            const issues = [];

            if (aiDevices.length > 0 && !hasAiRules) {
                issues.push(`AI强化有${aiDevices.length}个设备，但规则未注入`);
            }

            if (issues.length > 0) {
                Logger.error('Validator', `⚠️ 规则注入不完整:\n  ${issues.join('\n  ')}`);
                Logger.warn('Validator', '正在触发规则重新注入...');

                // 触发规则重新注入
                await RulesEngine.updateClashRules(gameDevices, aiDevices, proxyMacs);
                Logger.info('Validator', '✓ 规则已重新注入');
            } else {
                const rulesSummary = [
                    proxyMacs.length > 0 && `代理${proxyMacs.length}个`,
                    gameDevices.length > 0 && `游戏${gameDevices.length}个`,
                    aiDevices.length > 0 && `AI${aiDevices.length}个`
                ].filter(Boolean).join(', ') || '无';

                Logger.debug('Validator', `✓ 规则注入完整 (${rulesSummary})`);
            }
        } catch (err) {
            Logger.error('Validator', '验证Clash配置失败', err);
        }
    }

    // 定期检查（可选，用于长期运行）
    static startPeriodicValidation(intervalMs = 3600000) {
        setInterval(async () => {
            try {
                Logger.debug('Validator', '执行定期验证...');
                const dhcpLeases = await this.getDhcpLeases();
                await this.validateGameDevices(dhcpLeases);
                await this.validateAiDevices(dhcpLeases);
                await this.validateClashConfiguration();
            } catch (err) {
                Logger.error('Validator', '定期验证发生错误', err);
            }
        }, intervalMs);
    }
}

module.exports = SystemValidator;
