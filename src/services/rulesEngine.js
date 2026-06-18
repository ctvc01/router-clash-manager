const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('./sshService');
const ClashService = require('./clashService');
const { PROXY_GROUPS, ROUTER_PATHS, SPEEDTEST_URLS } = require('../constants');

class RulesEngine {
    // 核心规则注入与更新引擎
    static async updateClashRules(gameMacs, aiMacs) {
        // 动态探测当前配置文件中的 proxy-provider 名称
        let providerName = 'caomei1'; // 默认 fallback
        try {
            const providerOutput = await SshService.runRemoteCommand("grep -A 1 'proxy-providers:' /data/ShellCrash/yamls/config.yaml | tail -n 1 | cut -d: -f1 | tr -d ' '");
            if (providerOutput && providerOutput.trim().length > 0 && !providerOutput.includes('Error')) {
                providerName = providerOutput.trim();
            }
        } catch (pErr) {
            Logger.error('RulesEngine', '动态获取 proxy-provider 失败，退回默认 caomei1', pErr);
        }
        
        let leasesOutput = '';
        try {
            leasesOutput = await SshService.runRemoteCommand('cat /tmp/dhcp.leases');
        } catch (err) {
            Logger.error('RulesEngine', '获取 dhcp.leases 失败，无法进行规则注入', err);
        }
        
        const dhcpLeases = {};
        const leaseLines = leasesOutput.split('\n');
        for (const line of leaseLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                dhcpLeases[parts[1].toLowerCase()] = parts[2];
            }
        }
        
        // 构造分流规则
        const ruleLines = [];
        
        // 1. 注入游戏加速规则
        ruleLines.push(" # === GAME ACC START ===");
        for (const mac of gameMacs) {
            const ip = dhcpLeases[mac];
            if (!ip) continue;
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,192.168.0.0/16)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,10.0.0.0/8)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,172.16.0.0/12)),DIRECT`);
                
                // 大陆直连例外（优先放行国内流量/服务/国内 CDN 缓存下载，保障最佳下载速度）
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,cn)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOIP,CN)),DIRECT`);
                
                // 视频分流
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,youtube)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,googlevideo)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,ytimg.com)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,ggpht.com)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,vimeo.com)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,vimeocdn.com)),${PROXY_GROUPS.NODE_SELECT}`);

                // 任天堂 CDN 优化
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,video.nintendo)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,medias.nintendo)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,nintendo-trailer)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,akamaized.net)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,edgesuite.net)),${PROXY_GROUPS.NODE_SELECT}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,llnwi.net)),${PROXY_GROUPS.NODE_SELECT}`);
                
                // 游戏专线
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,cdn.nintendo.net)),${PROXY_GROUPS.GAME_ACC}`);

                ruleLines.push(` - SRC-IP-CIDR,${ip}/32,${PROXY_GROUPS.GAME_ACC}`);
        }
        ruleLines.push(" # === GAME ACC END ===");

        // 2. 注入 AI 强化规则
        ruleLines.push(" # === AI ACC START ===");
        for (const mac of aiMacs) {
            const ip = dhcpLeases[mac];
            if (!ip) continue;
                // 局域网直连拦截
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,192.168.0.0/16)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,10.0.0.0/8)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,172.16.0.0/12)),DIRECT`);
                
                // 大陆直连例外（防止国内网站/服务绕路境外代理，解决如微信公众号上传慢问题）
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,cn)),DIRECT`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOIP,CN)),DIRECT`);
                
                // 精细化 AI 服务流量分流（只将核心 AI 服务与资源引流到专线，其余常规国外流量落入常规代理）
                // Google AI 核心域名及交互接口（包含 Web 端、Stitch 以及 API 通道）
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,gemini.google.com)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,labs.google)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,aistudio.google)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,notebooklm.google)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN,generativelanguage.googleapis.com)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN,alkalimina-pa.clients6.google.com)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN,proactivebackend-pa.googleapis.com)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,openai)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,anthropic)),${PROXY_GROUPS.AI_BOOST}`);
                ruleLines.push(` - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,claude.ai)),${PROXY_GROUPS.AI_BOOST}`);
        }
        ruleLines.push(" # === AI ACC END ===");

        // 构造加速策略组
        const groupLines = [];
        
        // 1. 游戏加速策略组
        groupLines.push("  # === GAME GROUP START ===");
        if (gameMacs.length > 0) {
            groupLines.push(`  - {name: ${PROXY_GROUPS.GAME_ACC}, type: select, proxies: [${PROXY_GROUPS.GAME_SPEEDTEST}, ${PROXY_GROUPS.NODE_SELECT}, DIRECT], use: [${providerName}], filter: "(?i)(IPLC|IEPL|game|游戏)"}`);
            groupLines.push(`  - {name: ${PROXY_GROUPS.GAME_SPEEDTEST}, type: url-test, url: ${SPEEDTEST_URLS.NINTENDO}, interval: 300, tolerance: 30, include-all: true, filter: "(?i)(IPLC|IEPL|game|游戏)"}`);
        }
        groupLines.push("  # === GAME GROUP END ===");

        // 2. AI 强化策略组
        groupLines.push("  # === AI GROUP START ===");
        if (aiMacs.length > 0) {
            const aiFilter = "(?i)(IPLC|IEPL).*(Singapore|Japan|JP|USA|US|Korea|KR|Taiwan|TW|AI|GPT|Prime|新加坡|日本|韓|韩|台|美)";
            groupLines.push(`  - {name: ${PROXY_GROUPS.AI_BOOST}, type: select, proxies: [${PROXY_GROUPS.AI_SPEEDTEST}, ${PROXY_GROUPS.NODE_SELECT}, DIRECT], use: [${providerName}], filter: "${aiFilter}"}`);
            groupLines.push(`  - {name: ${PROXY_GROUPS.AI_SPEEDTEST}, type: url-test, url: ${SPEEDTEST_URLS.GOOGLE_AI}, interval: 300, tolerance: 30, include-all: true, filter: "${aiFilter}"}`);
        }
        groupLines.push("  # === AI GROUP END ===");
        
        try {
            // 1. 备份当前正常运行的配置文件
            await SshService.runRemoteCommand('cp -f /data/ShellCrash/yamls/config.yaml /tmp/config.yaml.bak');
            
            // 2. 写入临时游戏与 AI 规则与策略组
            await SshService.runRemoteCommand('rm -f /tmp/game_rules.txt /tmp/game_group.txt');

            // 写入规则文件（使用分段追加避免 heredoc 和 Base64 开销）
            if (ruleLines.length > 0) {
                for (const line of ruleLines) {
                    const escapedLine = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    await SshService.runRemoteCommand(`echo "${escapedLine}" >> /tmp/game_rules.txt`);
                }
            } else {
                await SshService.runRemoteCommand('touch /tmp/game_rules.txt');
            }

            // 写入策略组文件（使用分段追加）
            if (groupLines.length > 0) {
                for (const line of groupLines) {
                    const escapedLine = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    await SshService.runRemoteCommand(`echo "${escapedLine}" >> /tmp/game_group.txt`);
                }
            } else {
                await SshService.runRemoteCommand('touch /tmp/game_group.txt');
            }
            
            // 3. 安全地修改配置文件（使用被验证器接受的 sed 命令）
            // 步骤 1: 清理旧的注入段
            await SshService.runRemoteCommand("sed -i '/# === GAME ACC START ===/,/# === GAME ACC END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === AI ACC START ===/,/# === AI ACC END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === GAME GROUP START ===/,/# === GAME GROUP END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === AI GROUP START ===/,/# === AI GROUP END ===/d' /data/ShellCrash/yamls/config.yaml");

            // 步骤 2: 在 rules: 后插入规则（直接使用 sed 的 /pattern/r file 语法）
            if (ruleLines.length > 0) {
                await SshService.runRemoteCommand("sed -i '/^rules:$/r /tmp/game_rules.txt' /data/ShellCrash/yamls/config.yaml");
            }

            // 步骤 3: 在 proxy-groups: 后插入代理组
            if (groupLines.length > 0) {
                await SshService.runRemoteCommand("sed -i '/^proxy-groups:$/r /tmp/game_group.txt' /data/ShellCrash/yamls/config.yaml");
            }
            
            // 4. 自检配置语法
            try {
                await SshService.runRemoteCommand('/tmp/ShellCrash/CrashCore -t -d /data/ShellCrash -f /data/ShellCrash/yamls/config.yaml');
                Logger.info('RulesEngine', '新增规则后 Clash 配置文件自检通过！');
            } catch (testErr) {
                Logger.warn('RulesEngine', '新配置文件自检失败，正在执行安全回滚', testErr);
                await SshService.runRemoteCommand('cp -f /tmp/config.yaml.bak /data/ShellCrash/yamls/config.yaml');
                await SshService.runRemoteCommand(`curl -s -X PUT -d '{"path": "/data/ShellCrash/yamls/config.yaml"}' http://127.0.0.1:${config.ports.clash}/configs?force=true`);
                throw new Error('新配置自检失败，已自动回滚！错误详情: ' + (testErr.stderr || testErr.message || '配置语法错误'));
            }
            
            // 5. 触发 Clash 核心热重载 API
            await SshService.runRemoteCommand(`curl -s -X PUT -d '{"path": "/data/ShellCrash/yamls/config.yaml"}' http://127.0.0.1:${config.ports.clash}/configs?force=true`);
            Logger.info('RulesEngine', 'NAS端规则同步与 ClashMeta 重载指令下发成功！');
        } catch (err) {
            Logger.error('RulesEngine', 'Clash 规则配置文件远程更新异常', err);
            throw err;
        }
    }
}

module.exports = RulesEngine;
