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

        // 2b. 确保 tproxy-port 存在（游戏 UDP 透明代理）
        const hasTproxy = configLines.findIndex(line => line.trim().startsWith('tproxy-port:')) !== -1;
        if (!hasTproxy) {
            let redirIdx = configLines.findIndex(line => line.trim().startsWith('redir-port:'));
            if (redirIdx !== -1) {
                configLines.splice(redirIdx + 1, 0, 'tproxy-port: 7893');
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

       // 4. 强制重写或注入 dns 和 sniffer 配置段
        // 4.1 如果已存在 dns，整体替换整个 dns 配置段（保证配置一致性，包括 nameserver、fallback、store-fake-ip）
        const hasDns = currentConfig.includes('\ndns:');
        if (hasDns) {
            let dnsStart = -1, dnsEnd = -1, inDnsBlock = false;
            for (let i = 0; i < configLines.length; i++) {
                const line = configLines[i].trim();
                if (line.startsWith('dns:')) {
                    inDnsBlock = true; dnsStart = i; dnsEnd = i; continue;
                }
                if (inDnsBlock && line.length > 0 && !configLines[i].startsWith(' ') && !configLines[i].startsWith('\t') && !line.startsWith('#')) {
                    break;
                }
                if (inDnsBlock) dnsEnd = i;
            }
            if (dnsStart >= 0) {
                configLines.splice(dnsStart, dnsEnd - dnsStart + 1,
                    'dns:',
                    '  enable: true',
                    `  listen: 0.0.0.0:${config.ports.dns}`,
                    '  enhanced-mode: fake-ip',
                    '  fake-ip-range: 198.18.0.1/16',
                    '  prefer-h3: false',
                    '  nameserver:',
                    '    - 192.168.31.1',
                    '    - 114.114.114.114',
                    '    - 223.5.5.5',
                    '    - 119.29.29.29',
                    '  store-fake-ip: true',
                    '  fake-ip-filter:',
                    '    - +.nintendo.net',
                    '    - +.nintendo.com',
                    '    - +.nintendowifi.net',
                    '  cache-size: 8192'
                );
            }
        }

        // 4.2 注入缺少的 dns 和 sniffer 配置段
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
                    '  prefer-h3: false',
                    '  nameserver:',
                '    - 192.168.31.1',
                '    - 114.114.114.114',
                '    - 223.5.5.5',
                '    - 119.29.29.29',
                    '  store-fake-ip: true',
                    '  fake-ip-filter:',
                    '    - +.nintendo.net',
                    '    - +.nintendo.com',
                    '    - +.nintendowifi.net',
                    '  cache-size: 8192'
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

        // 5b. 清理旧的游戏分流规则
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('GAME RULES START')) return false;
            if (trimmed.includes('GAME RULES END')) return false;
            if (trimmed.includes('🎮 游戏加速') && !trimmed.includes('{name:')) return false;
            return true;
        });

        // 5c. 清理旧的国内直连规则
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('CN DIRECT RULES START')) return false;
            if (trimmed.includes('CN DIRECT RULES END')) return false;
            return true;
        });

        // 5d. 注入国内主流 App 域名直连规则（始终注入，受益所有代理设备）
        {
            const rulesIdx = configLines.findIndex(line => line.trim() === 'rules:');
            if (rulesIdx !== -1) {
                let rulesIndent = '  ';
                for (let i = rulesIdx + 1; i < configLines.length; i++) {
                    const line = configLines[i];
                    if (line.trim().startsWith('-')) {
                        const match = line.match(/^(\s*)-/);
                        if (match) rulesIndent = match[1];
                        break;
                    }
                    if (line.trim() !== '' && !line.trim().startsWith('#')) break;
                }

                const cnRuleLines = [
                    '# === CN DIRECT RULES START ===',
                    // Apple CDN 全段直连（Shadowrocket skip-proxy 等效，17.0.0.0/8 为 Apple 专属 AS714）
                    '- IP-CIDR,17.0.0.0/8,DIRECT,no-resolve',
                    // 视频/直播 CDN — 小红书、字节跳动/抖音、快手、B站
                    '- DOMAIN-SUFFIX,xhscdn.com,DIRECT',
                    '- DOMAIN-SUFFIX,snssdk.com,DIRECT',
                    '- DOMAIN-SUFFIX,bytedance.com,DIRECT',
                    '- DOMAIN-SUFFIX,ibytedtos.com,DIRECT',
                    '- DOMAIN-SUFFIX,bytecdn.cn,DIRECT',
                    '- DOMAIN-SUFFIX,volces.com,DIRECT',
                    '- DOMAIN-SUFFIX,kuaishou.com,DIRECT',
                    '- DOMAIN-SUFFIX,ksyun.com,DIRECT',
                    '- DOMAIN-SUFFIX,bilibili.com,DIRECT',
                    '- DOMAIN-SUFFIX,hdslb.com,DIRECT',
                    '- DOMAIN-SUFFIX,bilivideo.com,DIRECT',
                    // 电商图片 CDN — 阿里、京东、拼多多
                    '- DOMAIN-SUFFIX,alicdn.com,DIRECT',
                    '- DOMAIN-SUFFIX,aliyuncs.com,DIRECT',
                    '- DOMAIN-SUFFIX,360buyimg.com,DIRECT',
                    '- DOMAIN-SUFFIX,pddpic.com,DIRECT',
                    // 音乐流媒体 — 网易云音乐
                    '- DOMAIN-SUFFIX,126.net,DIRECT',
                    // 腾讯 CDN
                    '- DOMAIN-SUFFIX,gtimg.com,DIRECT',
                    '- DOMAIN-SUFFIX,qpic.cn,DIRECT',
                    '- DOMAIN-SUFFIX,myqcloud.com,DIRECT',
                    '# === CN DIRECT RULES END ==='
                ];

                const ruleLines = cnRuleLines.map(line => `${rulesIndent}${line}`);
                configLines.splice(rulesIdx + 1, 0, ...ruleLines);
            }
        }

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

        // 6b. 注入 Nintendo 游戏域名规则
        if (gameMacs.length > 0) {
            Logger.info('RulesEngine', '发现开启游戏加速的设备，正在注入 Nintendo 域名分流规则...');
            const rulesIdx = configLines.findIndex(line => line.trim() === 'rules:');
            if (rulesIdx !== -1) {
                let rulesIndent = '  ';
                for (let i = rulesIdx + 1; i < configLines.length; i++) {
                    const line = configLines[i];
                    if (line.trim().startsWith('-')) {
                        const match = line.match(/^(\s*)-/);
                        if (match) rulesIndent = match[1];
                        break;
                    }
                    if (line.trim() !== '' && !line.trim().startsWith('#')) break;
                }

                const gameRuleLines = [
                    '# === GAME RULES START ===',
                    // 联机匹配、商城与连通测速走游戏加速
                    '- DOMAIN-SUFFIX,ctest.cdn.nintendo.net,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,bugyo.hac.lp1.eshop.nintendo.net,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,api.accounts.nintendo.com,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,accounts.nintendo.com,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,ec.nintendo.net,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,atlas-content.nintendo.net,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,atum-ec.nintendo.net,🎮 游戏加速',
                    '- DOMAIN-SUFFIX,receive-lp1.dg.srv.nintendo.net,🎮 游戏加速',
                    // 大流量游戏/补丁下载 CDN 走直连 (DIRECT) 跑满物理大宽带
                    '- DOMAIN-SUFFIX,atum.download.nintendo.net,DIRECT',
                    '- DOMAIN-SUFFIX,hac.lp1.d4c.nintendo.net,DIRECT',
                    '# === GAME RULES END ==='
                ];

                const ruleLines = gameRuleLines.map(line => `${rulesIndent}${line}`);
                configLines.splice(rulesIdx + 1, 0, ...ruleLines);
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
            const selectMatch = currentConfig.match(/name:\s*['"]?([^\n'",{}]*(?:选择节点|节点选择))['"]?/);
            const actualNodeSelect = selectMatch ? selectMatch[1] : PROXY_GROUPS.NODE_SELECT;

            // 提取物理节点名称以供自适应注入
            const physicalNodeNames = [];
            let inProxiesBlock = false;
            for (let i = 0; i < configLines.length; i++) {
                const line = configLines[i].trim();
                if (line === 'proxies:') {
                    inProxiesBlock = true;
                    continue;
                }
                if (inProxiesBlock) {
                    if (line.length > 0 && !line.startsWith('-') && !line.startsWith(' ') && !line.startsWith('#')) {
                        inProxiesBlock = false;
                    } else if (line.startsWith('-')) {
                        const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/) || line.match(/name:\s*['"]?([^'"\n]+)['"]?/);
                        if (nameMatch) {
                            physicalNodeNames.push(nameMatch[1].trim());
                        }
                    }
                }
            }

            // 获取可用的 proxy-provider 名称进行兜底
            let providerName = 'subscription';
            const providerMatch = currentConfig.match(/^\s*([^\s#:]+):\s*\n\s*type:\s*http/m);
            if (providerMatch) {
                providerName = providerMatch[1];
            }

            if (gameMacs.length > 0) {
                if (physicalNodeNames.length > 0) {
                    let gameNodes = physicalNodeNames.filter(name => /(Japan|Korea|Taiwan|日本|韩国|台灣|台湾|JP|KR|TW)/i.test(name));
                    if (gameNodes.length === 0) gameNodes = physicalNodeNames.slice(0, 15);
                    const nodesStr = gameNodes.map(n => `'${n}'`).join(', ');
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_SPEEDTEST}', type: url-test, tolerance: 50, interval: 300, proxies: [${nodesStr}]}`);
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_ACC}', type: select, proxies: ['${PROXY_GROUPS.GAME_SPEEDTEST}', '${actualNodeSelect}', 'DIRECT']}`);
                } else {
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_SPEEDTEST}', type: url-test, tolerance: 50, interval: 300, use: [${providerName}], filter: "(?i)(Japan|Korea|Taiwan|日本|韩国|台灣|台湾|JP|KR|TW)"}`);
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_ACC}', type: select, proxies: ['${PROXY_GROUPS.GAME_SPEEDTEST}', '${actualNodeSelect}', 'DIRECT'], use: [${providerName}], filter: "(?i)(Japan|Korea|Taiwan|日本|韩国|台灣|台湾|JP|KR|TW)"}`);
                }
            }

            if (aiMacs.length > 0) {
                const aiGroupProxies = [actualNodeSelect];
                const groupMatches = currentConfig.matchAll(/name:\s*['"]?([^\n'",{}]*(?:自动|Auto|节点)[^\n'",{}]*)['"]?/gi);
                for (const match of groupMatches) {
                    const gName = match[1].trim();
                    if (gName !== PROXY_GROUPS.AI_BOOST && gName !== PROXY_GROUPS.AI_SPEEDTEST &&
                        gName !== PROXY_GROUPS.GAME_ACC && gName !== PROXY_GROUPS.GAME_SPEEDTEST &&
                        !aiGroupProxies.includes(gName)) {
                        aiGroupProxies.push(gName);
                    }
                }
                
                // 将所有物理节点也追加入备选，使其支持任意节点的点选锁定
                if (physicalNodeNames.length > 0) {
                    for (const pName of physicalNodeNames) {
                        if (!aiGroupProxies.includes(pName)) {
                            aiGroupProxies.push(pName);
                        }
                    }
                }
                
                const aiProxiesStr = aiGroupProxies.map(n => `'${n}'`).join(', ');
                
                if (physicalNodeNames.length > 0) {
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.AI_BOOST}', type: select, proxies: [${aiProxiesStr}]}`);
                } else {
                    groupLines.push(`${indent}- {name: '${PROXY_GROUPS.AI_BOOST}', type: select, proxies: [${aiProxiesStr}], use: [${providerName}]}`);
                }
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
            Logger.info('RulesEngine', '分流策略：国内域名→DIRECT, GEOIP,CN→DIRECT, MATCH→代理');

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

                // 5. 检测配置是否真正发生了变化，避免无意义 Clash 重启
                let configChanged = true;
                try {
                    const currentRouterConfig = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
                    if (currentRouterConfig === finalConfig) {
                        Logger.info('RulesEngine', '配置内容未变化，跳过 Clash 重启');
                        configChanged = false;
                    }
                } catch (e) {
                    Logger.warn('RulesEngine', '无法读取当前配置进行对比，继续应用', e.message);
                }

                if (configChanged) {
                    // 把工作文件安全写回 /data
                    await SshService.runRemoteCommand(`cp -f ${workFile} /data/ShellCrash/config.yaml`);
                    await SshService.runRemoteCommand(`rm -f ${workFile}`);

                    // Cold restart Clash core
                    await SshService.runRemoteCommand(
                        'killall mihomo Clash 2>/dev/null; sleep 2; ( /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null & )'
                    );
                    SshService.updateLastRestartTime();
                    Logger.info('RulesEngine', '等待 Clash 重启...');
                    await new Promise(r => setTimeout(r, 5000));
                } else {
                    // 清理临时文件，不重启
                    await SshService.runRemoteCommand(`rm -f ${workFile}`);
                }

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
