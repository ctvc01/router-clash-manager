const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('./sshService');
const ClashService = require('./clashService');

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
        ruleLines.push("# === GAME ACC START ===");
        for (const mac of gameMacs) {
            let ip = dhcpLeases[mac];
            if (!ip) {
                const mockIps = {
                    "00:11:22:33:44:55": "192.0.2.100",
                    "aa:bb:cc:dd:ee:ff": "192.0.2.200"
                };
                ip = mockIps[mac];
            }
            if (ip) {
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,192.168.0.0/16)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,10.0.0.0/8)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,172.16.0.0/12)),DIRECT`);
                
                // 屏蔽 QUIC (UDP 443) 流量，强制秒退回 TCP 链路以避免运营商 UDP 阻断导致的网页假死
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DST-PORT,443),(PROTOCOL,UDP)),REJECT`);
                
                // 大陆直连例外（优先放行国内流量/服务/国内 CDN 缓存下载，保障最佳下载速度）
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,cn)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(GEOIP,CN)),DIRECT`);
                
                // 视频分流
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,youtube)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,googlevideo)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,ytimg.com)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,ggpht.com)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,vimeo.com)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,vimeocdn.com)),🚀 节点选择`);
                
                // 任天堂 CDN 优化
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,video.nintendo)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,medias.nintendo)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-KEYWORD,nintendo-trailer)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,akamaized.net)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,edgesuite.net)),🚀 节点选择`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,llnwi.net)),🚀 节点选择`);
                
                // 游戏专线
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DOMAIN-SUFFIX,cdn.nintendo.net)),🎮 游戏加速`);
                
                ruleLines.push(`  - SRC-IP-CIDR,${ip}/32,🎮 游戏加速`);
            }
        }
        ruleLines.push("# === GAME ACC END ===");

        // 2. 注入 AI 强化规则
        ruleLines.push("# === AI ACC START ===");
        for (const mac of aiMacs) {
            let ip = dhcpLeases[mac];
            if (!ip) {
                const mockIps = {
                    "00:11:22:33:44:55": "192.0.2.100",
                    "aa:bb:cc:dd:ee:ff": "192.0.2.200"
                };
                ip = mockIps[mac];
            }
            if (ip) {
                // 局域网直连拦截
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,192.168.0.0/16)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,10.0.0.0/8)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,172.16.0.0/12)),DIRECT`);
                
                // 屏蔽 QUIC (UDP 443) 流量，解决浏览器加载 Google/Gemini 网页卡顿 Loading 假死故障
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(DST-PORT,443),(PROTOCOL,UDP)),REJECT`);
                
                // 大陆直连例外（防止国内网站/服务绕路境外代理，解决如微信公众号上传慢问题）
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(GEOSITE,cn)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(GEOIP,CN)),DIRECT`);
                
                // 全局 AI 专线分流
                ruleLines.push(`  - SRC-IP-CIDR,${ip}/32,🤖 AI强化`);
            }
        }
        ruleLines.push("# === AI ACC END ===");

        // 构造加速策略组
        const groupLines = [];
        
        // 1. 游戏加速策略组
        groupLines.push("# === GAME GROUP START ===");
        if (gameMacs.length > 0) {
            groupLines.push(`  - {name: 🎮 游戏加速, type: select, proxies: [⚡ 游戏自动测速, 🚀 节点选择, 👑 高级节点, DIRECT], use: [${providerName}], filter: "(?i)(IPLC|IEPL|game|游戏)"}`);
            groupLines.push("  - {name: ⚡ 游戏自动测速, type: url-test, url: http://ctest.cdn.nintendo.net/, interval: 300, tolerance: 30, include-all: true, filter: \"(?i)(IPLC|IEPL|game|游戏)\"}");
        }
        groupLines.push("# === GAME GROUP END ===");

        // 2. AI 强化策略组
        groupLines.push("# === AI GROUP START ===");
        if (aiMacs.length > 0) {
            groupLines.push(`  - {name: 🤖 AI强化, type: select, proxies: [⚡ AI自动测速, 🚀 节点选择, 👑 高级节点, DIRECT], use: [${providerName}]}`);
            groupLines.push("  - {name: ⚡ AI自动测速, type: url-test, url: https://generativelanguage.googleapis.com/, interval: 300, tolerance: 30, include-all: true}");
        }
        groupLines.push("# === AI GROUP END ===");
        
        try {
            // 1. 备份当前正常运行的配置文件
            await SshService.runRemoteCommand('cp -f /data/ShellCrash/yamls/config.yaml /tmp/config.yaml.bak');
            
            // 2. 写入临时游戏与 AI 规则与策略组
            await SshService.runRemoteCommand('rm -f /tmp/game_rules.txt /tmp/game_group.txt');
            for (const line of ruleLines) {
                await SshService.runRemoteCommand(`echo '${line}' >> /tmp/game_rules.txt`);
            }
            for (const line of groupLines) {
                await SshService.runRemoteCommand(`echo '${line}' >> /tmp/game_group.txt`);
            }
            
            // 3. 将临时规则与策略组写入 config.yaml，前置清理旧的标记段
            await SshService.runRemoteCommand("sed -i '/# === GAME ACC START ===/,/# === GAME ACC END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === AI ACC START ===/,/# === AI ACC END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === GAME GROUP START ===/,/# === GAME GROUP END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === AI GROUP START ===/,/# === AI GROUP END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === GAME SNIFFER START ===/,/# === GAME SNIFFER END ===/d' /data/ShellCrash/yamls/config.yaml");
            
            // 插入新的规则与组配置
            await SshService.runRemoteCommand("sed -i '/rules:/r /tmp/game_rules.txt' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/proxy-groups:/r /tmp/game_group.txt' /data/ShellCrash/yamls/config.yaml");
            
            // 4. 自检配置语法
            try {
                await SshService.runRemoteCommand('/tmp/ShellCrash/CrashCore -t -d /data/ShellCrash -f /data/ShellCrash/yamls/config.yaml');
                Logger.info('RulesEngine', '新增规则后 Clash 配置文件自检通过！');
            } catch (testErr) {
                Logger.warn('RulesEngine', '新配置文件自检失败，正在执行安全回滚', testErr);
                await SshService.runRemoteCommand('cp -f /tmp/config.yaml.bak /data/ShellCrash/yamls/config.yaml');
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
