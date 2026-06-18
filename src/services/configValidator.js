const SshService = require('./sshService');
const Logger = require('../utils/logger');

class ConfigValidator {
    // 验证YAML语法
    static async validateYamlSyntax(configPath) {
        try {
            const cmd = `/tmp/ShellCrash/CrashCore -t -d /data/ShellCrash -f ${configPath}`;
            await SshService.runRemoteCommand(cmd);
            Logger.info('ConfigValidator', '✅ YAML语法校验通过');
            return { valid: true };
        } catch (e) {
            Logger.warn('ConfigValidator', '❌ YAML语法校验失败', e);
            return { valid: false, error: e.message || e.stderr || '语法错误' };
        }
    }

    // 验证配置会不会导致节点列表清空
    static async validateProxyNodes(configPath) {
        try {
            // 检查配置是否包含proxy-providers
            const checkProviders = `grep -c 'proxy-providers:' ${configPath}`;
            const hasProviders = await SshService.runRemoteCommand(checkProviders).catch(() => '0');

            if (hasProviders.trim() === '0') {
                Logger.warn('ConfigValidator', '⚠️ 配置中未找到 proxy-providers，节点列表可能为空');
                return {
                    valid: false,
                    warning: true,
                    error: '缺少 proxy-providers 配置，可能导致节点列表为空',
                    suggestion: '请检查订阅链接是否配置正确'
                };
            }

            // 检查proxy-groups是否存在
            const checkGroups = `grep -c 'proxy-groups:' ${configPath}`;
            const hasGroups = await SshService.runRemoteCommand(checkGroups).catch(() => '0');

            if (hasGroups.trim() === '0') {
                Logger.warn('ConfigValidator', '⚠️ 配置中未找到 proxy-groups，代理组可能丢失');
                return {
                    valid: false,
                    warning: true,
                    error: '缺少 proxy-groups 配置',
                    suggestion: '请确保规则注入未损坏proxy-groups'
                };
            }

            Logger.info('ConfigValidator', '✅ 节点列表校验通过');
            return { valid: true, warning: false };
        } catch (e) {
            Logger.error('ConfigValidator', '节点列表校验异常', e);
            return {
                valid: false,
                error: '校验异常: ' + (e.message || '未知错误')
            };
        }
    }

    // 完整的配置校验流程
    static async validateComplete(configPath) {
        const results = {
            timestamp: new Date().toISOString(),
            configPath,
            checks: {}
        };

        // 1. 语法检查
        Logger.info('ConfigValidator', '开始配置校验...');
        results.checks.syntax = await this.validateYamlSyntax(configPath);
        if (!results.checks.syntax.valid) {
            results.valid = false;
            return results;
        }

        // 2. 节点检查
        results.checks.proxies = await this.validateProxyNodes(configPath);
        if (!results.checks.proxies.valid && results.checks.proxies.warning) {
            Logger.warn('ConfigValidator', '⚠️ 配置校验有警告，但可能可以接受');
            results.valid = true;
            results.hasWarnings = true;
        } else if (!results.checks.proxies.valid) {
            results.valid = false;
            return results;
        }

        results.valid = true;
        Logger.info('ConfigValidator', '✅ 完整配置校验通过');
        return results;
    }

    // 对比两个配置的差异
    static async compareConfigs(oldPath, newPath) {
        try {
            const oldContent = await SshService.runRemoteCommand(`cat ${oldPath}`);
            const newContent = await SshService.runRemoteCommand(`cat ${newPath}`);

            const oldLines = oldContent.split('\n').length;
            const newLines = newContent.split('\n').length;

            // 简单的diff统计
            const changes = {
                oldLineCount: oldLines,
                newLineCount: newLines,
                linesDiff: newLines - oldLines,
                hasRulesChanges: oldContent.includes('# === GAME ACC START') !== newContent.includes('# === GAME ACC START'),
                hasGroupChanges: oldContent.includes('proxy-groups:') !== newContent.includes('proxy-groups:')
            };

            Logger.debug('ConfigValidator', '配置差异分析完成');
            return changes;
        } catch (e) {
            Logger.error('ConfigValidator', '配置对比失败', e);
            return null;
        }
    }

    // 预检查：在应用规则前先验证
    static async preCheckBeforeApply(configPath) {
        Logger.info('ConfigValidator', '执行规则应用前的预检查...');

        const validation = await this.validateComplete(configPath);

        if (!validation.valid) {
            Logger.error('ConfigValidator', '❌ 预检查失败，拒绝应用配置', validation.checks);
            return {
                canApply: false,
                reason: validation.checks.syntax?.error || validation.checks.proxies?.error || '未知错误',
                validation
            };
        }

        if (validation.hasWarnings) {
            Logger.warn('ConfigValidator', '⚠️ 预检查有警告但通过');
            return {
                canApply: true,
                hasWarnings: true,
                warnings: Object.values(validation.checks)
                    .filter(c => c.warning)
                    .map(c => c.error),
                validation
            };
        }

        Logger.info('ConfigValidator', '✅ 预检查通过，允许应用配置');
        return {
            canApply: true,
            hasWarnings: false,
            validation
        };
    }
}

module.exports = ConfigValidator;
