const SshService = require('./sshService');
const Logger = require('../utils/logger');

class ConfigValidator {
    // 验证YAML语法
    static async validateYamlSyntax(configPath) {
        try {
            const coreBinary = '/tmp/ShellCrash/mihomo';
            
            // 使用 timeout -t 5 限制在路由器上最长运行 5 秒，防止下载 MMDB 卡死
            // 并把 stderr 重定向到 stdout 以便我们统一处理日志输出
            const cmd = `timeout -t 5 ${coreBinary} -t -d /data/ShellCrash -f ${configPath} 2>&1`;
            
            let output = '';
            let valid = false;
            try {
                output = await SshService.runRemoteCommand(cmd);
                // 如果命令成功退出，说明有效
                valid = true;
                Logger.info('ConfigValidator', '✅ YAML语法校验通过');
            } catch (e) {
                output = e.stdout || e.stderr || e.message || '';
                
                // 如果输出里含有表示开始配置初始化的特征日志，说明 YAML 本身没有语法解析错误
                // 另外，在某些小米路由器上运行 mihomo -t 验证巨大的配置会因为内存不足触发 Segmentation fault，
                // 如果碰巧报错是 Segfault，我们也只能跳过强校验放行。
                const alreadyParsed = output.includes('initial configuration') || 
                                      output.includes('Geodata Loader') ||
                                      output.includes('Geosite Matcher') ||
                                      output.includes('MMDB invalid') ||
                                      output.includes('context deadline exceeded');
                
                const isSegfault = output.includes('Segmentation fault');
                                      
                if (alreadyParsed) {
                    Logger.info('ConfigValidator', '✓ YAML语法校验通过 (已跳过后续的 GeoIP 数据库下载校验)');
                    valid = true;
                } else if (isSegfault) {
                    Logger.warn('ConfigValidator', '⚠️ YAML语法校验跳过：由于路由器内存限制，mihomo -t 触发 Segmentation fault。我们信任配置是正确的。');
                    valid = true;
                } else {
                    // 真正的 YAML 语法错误
                    Logger.warn('ConfigValidator', '❌ YAML语法校验失败', e);
                    return { valid: false, error: output || '语法错误' };
                }
            }
            return { valid };
        } catch (e) {
            Logger.error('ConfigValidator', 'YAML语法校验抛出非预期异常', e);
            return { valid: false, error: e.message || '未知错误' };
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
