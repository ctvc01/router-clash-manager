const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('./sshService');
const ClashService = require('./clashService');
const ConfigValidator = require('./configValidator');
const ChangelogManager = require('./changelogManager');
const ConfigVersionManager = require('./configVersionManager');
const BackupService = require('./backupService');
const { PROXY_GROUPS } = require('../constants');
const fs = require('fs');

let updatePromise = Promise.resolve(); // 串行注入锁

class RulesEngine {
    // 内存改写配置的纯函数，解耦 SSH 和文件 IO，方便单元测试
    static modifyConfigText(currentConfig, gameMacs = [], aiMacs = []) {
        let configLines = currentConfig.split('\n');

        // 1. 强制关闭 tun: enable，因为本系统使用自定义 iptables 透明引流，无需 TUN 网卡且 TUN 在老旧内核上会导致 syscall 434 崩溃
        let inTunBlock = false;
        for (let i = 0; i < configLines.length; i++) {
            const originalLine = configLines[i];
            const line = originalLine.trim();
            if (line.startsWith('tun:')) {
                inTunBlock = true;
                continue;
            }
            // 如果处于 tun 块中，遇到非空行且不是缩进（不以空格/Tab开头），且不是注释，则认为退出 tun 块
            if (inTunBlock && line.length > 0 && !originalLine.startsWith(' ') && !originalLine.startsWith('\t') && !line.startsWith('#')) {
                inTunBlock = false;
            }
            if (inTunBlock && line.startsWith('enable:')) {
                const indent = originalLine.match(/^\s*/)[0];
                configLines[i] = `${indent}enable: false`;
                inTunBlock = false; // 替换后即可退出 tun 块
            }
        }

        // 2. 强制开启 allow-lan: true，防止被局域网代理阻塞导致断网
        let allowLanIdx = configLines.findIndex(line => line.trim().startsWith('allow-lan:'));
        if (allowLanIdx !== -1) {
            configLines[allowLanIdx] = 'allow-lan: true';
        } else {
            let mixedPortIdx = configLines.findIndex(line => line.trim().startsWith('mixed-port:'));
            if (mixedPortIdx !== -1) {
                configLines.splice(mixedPortIdx + 1, 0, 'allow-lan: true');
            }
        }

        // 3. 强制将 external-controller 的端口设置为 config.ports.clash (默认 9999)
        let controllerIdx = configLines.findIndex(line => line.trim().startsWith('external-controller:'));
        if (controllerIdx !== -1) {
            configLines[controllerIdx] = `external-controller: '0.0.0.0:${config.ports.clash}'`;
        } else {
            let mixedPortIdx = configLines.findIndex(line => line.trim().startsWith('mixed-port:'));
            if (mixedPortIdx !== -1) {
                configLines.splice(mixedPortIdx + 1, 0, `external-controller: '0.0.0.0:${config.ports.clash}'`);
            }
        }

        // 4. 注入 dns 和 sniffer 配置段
        const hasDns = currentConfig.includes('\ndns:');
        const hasSniffer = currentConfig.includes('\nsniffer:');
        let insertIdx = configLines.findIndex(line => line.trim().startsWith('mixed-port:'));
        
        if (insertIdx !== -1) {
            if (!hasDns) {
                Logger.info('RulesEngine', '检测到 Clash 配置文件未开启 dns，正在内存中自动注入...');
                const dnsLines = [
                    'dns:',
                    '  enable: true',
                    `  listen: 0.0.0.0:${config.ports.dns}`,
                    '  enhanced-mode: fake-ip',
                    '  fake-ip-range: 198.18.0.1/16',
                    '  nameserver:',
                    '    - 114.114.114.114',
                    '    - 223.5.5.5',
                    '    - 8.8.8.8'
                ];
                configLines.splice(insertIdx + 1, 0, ...dnsLines);
                insertIdx += dnsLines.length;
            }
            
            if (!hasSniffer) {
                Logger.info('RulesEngine', '检测到 Clash 配置文件未开启 sniffer，正在内存中自动注入...');
                const snifferLines = [
                    'sniffer:',
                    '  enable: true',
                    '  force-dns-mapping: false',
                    '  parse-pure-ip-address: true'
                ];
                configLines.splice(insertIdx + 1, 0, ...snifferLines);
            }
        }

        // 5. 清理旧的 AI 分流规则
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('AI RULES START')) return false;
            if (trimmed.includes('AI RULES END')) return false;
            if (trimmed.includes('🤖 AI强化')) return false;
            if (trimmed.includes('jinjitu.com,DIRECT')) return false;
            return true;
        });

        // 6. 注入最新的 AI 分流规则
        if (aiMacs.length > 0) {
            Logger.info('RulesEngine', '发现开启 AI 强化的设备，正在注入 AI 域名分流规则...');
            const rulesIdx = configLines.findIndex(line => line.trim() === 'rules:');
            if (rulesIdx !== -1) {
                let rulesIndent = '  '; // 默认2空格
                for (let i = rulesIdx + 1; i < configLines.length; i++) {
                    const line = configLines[i];
                    if (line.trim().startsWith('-')) {
                        const match = line.match(/^(\s*)-/);
                        if (match) {
                            rulesIndent = match[1];
                        }
                        break;
                    }
                    if (line.trim() !== '' && !line.trim().startsWith('#')) {
                        break;
                    }
                }

                const baseRuleLines = [
                    '# === AI RULES START ===',
                    '- DOMAIN-SUFFIX,openai.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,chatgpt.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,oaistatic.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,oaiusercontent.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,claude.ai,🤖 AI强化',
                    '- DOMAIN-SUFFIX,anthropic.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gemini.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,generativelanguage.googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,ai.google.dev,🤖 AI强化',
                    '- DOMAIN-SUFFIX,makersuite.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,aistudio.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,deepmind.google,🤖 AI强化',
                    '- DOMAIN-SUFFIX,deepmind.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,generativeai.google,🤖 AI强化',
                    '- DOMAIN-KEYWORD,colab,🤖 AI强化',
                    '- DOMAIN-KEYWORD,developer.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gstatic.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,googleusercontent.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gvt1.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,ggpht.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,android.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,youtube.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,youtubei.googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,ytimg.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,googlevideo.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,youtu.be,🤖 AI强化',
                    '- DOMAIN-SUFFIX,jinjitu.com,DIRECT',
                    '# === AI RULES END ==='
                ];

                const ruleLines = baseRuleLines.map(line => `${rulesIndent}${line}`);
                configLines.splice(rulesIdx + 1, 0, ...ruleLines);
            } else {
                Logger.error('RulesEngine', '未找到 rules: 配置段，无法注入规则！');
                throw new Error('未找到 rules: 配置段');
            }
        }

        // 7. 清理旧的代理组行（防止乱码重复注入）
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith('-') && trimmed.includes('{name:')) {
                if (trimmed.includes('AI强化') || trimmed.includes('AI自动测速')) return false;
                if (trimmed.includes('游戏加速') || trimmed.includes('游戏自动测速')) return false;
            }
            return true;
        });

        // 8. 寻找并注入 proxy-groups: 字段
        const groupsIdx = configLines.findIndex(line => line.trim() === 'proxy-groups:');
        if (groupsIdx !== -1) {
            let indent = '  '; // 默认2空格
            for (let i = groupsIdx + 1; i < configLines.length; i++) {
                const line = configLines[i];
                if (line.trim().startsWith('-')) {
                    const match = line.match(/^(\s*)-/);
                    if (match) {
                        indent = match[1];
                    }
                    break;
                }
                if (line.trim() !== '' && !line.trim().startsWith('#')) {
                    break;
                }
            }

            const groupLines = [];
            const selectMatch = currentConfig.match(/name:\s*['"]?([^'"\n]*(?:选择节点|节点选择))['"]?/);
            const actualNodeSelect = selectMatch ? selectMatch[1] : PROXY_GROUPS.NODE_SELECT;

            // 提取所有可能包含“自动”的代理组
            const aiGroupProxies = [actualNodeSelect];
            const groupMatches = currentConfig.matchAll(/name:\s*['"]?([^\n'"]*(?:自动|Auto|节点)[^\n'"]*)['"]?/gi);
            for (const m of groupMatches) {
                const name = m[1];
                if (name.includes('说明') || name.includes('提示') || name.includes('官网') || name.includes(':') || name.includes('：')) {
                    continue;
                }
                if (name.includes('AI自动') || name.includes('AI强化') || name.includes('游戏自动') || name.includes('游戏加速')) {
                    continue;
                }
                if (name !== actualNodeSelect && !aiGroupProxies.includes(name) && !name.includes('香港') && !name.includes('HK')) {
                    aiGroupProxies.push(name);
                }
            }
            if (!aiGroupProxies.includes('DIRECT')) aiGroupProxies.push('DIRECT');
            const aiProxiesStr = aiGroupProxies.map(p => `'${p}'`).join(', ');

            if (gameMacs.length > 0) {
                groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_ACC}', type: select, proxies: ['${actualNodeSelect}', 'DIRECT']}`);
            }

            if (aiMacs.length > 0) {
                groupLines.push(`${indent}- {name: '${PROXY_GROUPS.AI_BOOST}', type: select, proxies: [${aiProxiesStr}]}`);
            }

            if (groupLines.length > 0) {
                configLines.splice(groupsIdx + 1, 0, ...groupLines);
            }
        } else {
            Logger.error('RulesEngine', '未找到 proxy-groups: 配置段，无法注入代理组！');
            throw new Error('未找到 proxy-groups: 配置段');
        }

        return configLines.join('\n');
    }

    // 核心逻辑：设备分流由全局 GEOIP 规则处理，RulesEngine 仅负责代理组管理
    static async updateClashRules(gameMacs, aiMacs, proxyMacs = []) {
        updatePromise = updatePromise.then(async () => {
            Logger.info('RulesEngine', `设备统计: 代理${proxyMacs.length}个, 游戏${gameMacs.length}个, AI${aiMacs.length}个 (排队执行中)`);
            Logger.info('RulesEngine', '分流由全局 GEOIP 规则处理（GEOIP,CN→DIRECT, MATCH→代理）');

            // 1. 获取路由器当前的主配置文件内容
            let currentConfig = '';
            try {
                currentConfig = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
            } catch (err) {
                Logger.error('RulesEngine', '获取路由器主配置失败，无法进行注入', err);
                throw err;
            }

            // 自动拉取自愈：如果主配置文件为空，说明已被损坏，自动使用订阅链接紧急拉取
            if (!currentConfig.trim()) {
                Logger.warn('RulesEngine', '⚠️ 探测到路由器主配置文件为 0 字节空文件，正在尝试通过订阅链接执行全自动紧急拉取自愈...');
                try {
                    await SshService.runRemoteCommand(
                        `curl -k -o /data/ShellCrash/config.yaml "https://www.cmsub.com/subscribe/WUK1BZDNN7ICBIIB?clash=ssr&trojan"`
                    );
                    currentConfig = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
                    Logger.info('RulesEngine', '✅ 订阅配置文件自动拉取拉回成功！');
                } catch (dlErr) {
                    Logger.error('RulesEngine', '❌ 自动拉取配置文件失败！', dlErr);
                    throw new Error('路由器主配置文件为空且自动拉取下载失败！');
                }
            }

            // 备份当前配置
            await SshService.runRemoteCommand('cp -f /data/ShellCrash/config.yaml /tmp/config.yaml.bak');

            // 生成本次执行专用的唯一临时文件名，彻底杜绝并发踩踏 Race Condition
            const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const workFile = `/tmp/config_work_${uniqueId}.yaml`;

            // 2. 在内存中改写配置文本
            let finalConfig;
            try {
                finalConfig = RulesEngine.modifyConfigText(currentConfig, gameMacs, aiMacs);
            } catch (modifyErr) {
                Logger.error('RulesEngine', '内存解析并重写 YAML 配置失败', modifyErr);
                throw modifyErr;
            }

            // 双重校验：检查全局规则完整性 (兼容新版基于 RULE-SET 的订阅)
            const hasGeoip = finalConfig.includes('GEOIP') || finalConfig.includes('RULE-SET');
            const hasMatch = finalConfig.includes('MATCH');
            if (!hasGeoip || !hasMatch) {
                Logger.error('RulesEngine', '生成的新配置全局规则不完整，拒绝写入！');
                throw new Error('全局规则完整性检查失败');
            }

            try {
                // 将配置写到容器本地临时文件
                const localWorkFile = `/tmp/local_config_work_${uniqueId}.yaml`;
                fs.writeFileSync(localWorkFile, finalConfig);
                
                // 将本地文件上传到路由器临时目录
                await SshService.uploadFileLocal(localWorkFile, workFile);
                fs.unlinkSync(localWorkFile);

                // 4. 对工作文件运行验证
                const preCheckResult = await ConfigValidator.preCheckBeforeApply(workFile);
                if (!preCheckResult.canApply) {
                    Logger.error('RulesEngine', '配置预检查失败: ' + preCheckResult.reason);
                    await SshService.runRemoteCommand(`rm -f ${workFile}`);
                    throw new Error('配置预检查失败: ' + preCheckResult.reason);
                }

                if (preCheckResult.hasWarnings) {
                    Logger.warn('RulesEngine', '配置有警告: ' + preCheckResult.warnings.join('; '));
                }

                // 5. 顺利通过所有检查！现在把工作文件安全写回 /data
                await SshService.runRemoteCommand(`cp -f ${workFile} /data/ShellCrash/config.yaml`);
                await SshService.runRemoteCommand(`rm -f ${workFile}`);

                // Cold restart Clash core
                await SshService.runRemoteCommand(
                    'killall mihomo Clash 2>/dev/null; sleep 2; ( /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null & )'
                );
                Logger.info('RulesEngine', '等待 Clash 重启...');
                await new Promise(r => setTimeout(r, 12000));

                ConfigVersionManager.createSnapshot('/data/ShellCrash/config.yaml', '.applied');
                try {
                    const gateway = require('../routes/gateway');
                    if (gateway && typeof gateway.clearMainGroupCache === 'function') {
                        gateway.clearMainGroupCache();
                    }
                } catch (cacheErr) {
                    // Ignore
                }
                ChangelogManager.logRulesUpdate(gameMacs, aiMacs, true);
                Logger.info('RulesEngine', '代理组注入成功');

                // 自动异步执行配置备份
                BackupService.performBackup().catch(backupErr => {
                    Logger.error('RulesEngine', '自动配置备份触发失败', backupErr);
                });
            } catch (err) {
                Logger.error('RulesEngine', '代理组注入异常', err);
                await SshService.runRemoteCommand(`rm -f ${workFile}`);
                await SshService.runRemoteCommand('cp -f /tmp/config.yaml.bak /data/ShellCrash/config.yaml 2>/dev/null || true');
                throw err;
            }
        }).catch(err => {
            Logger.error('RulesEngine', '串行规则注入执行失败', err);
            throw err;
        });
        return updatePromise;
    }
}

module.exports = RulesEngine;
