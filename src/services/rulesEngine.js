const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('./sshService');
const ClashService = require('./clashService');

class RulesEngine {
    // 核心规则注入与更新引擎
    static async updateClashRules(gameMacs) {
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
        const ruleLines = ["# === GAME ACC START ==="];
        for (const mac of gameMacs) {
            let ip = dhcpLeases[mac];
            if (!ip) {
                const mockIps = {
                    // 示例：使用 RFC 5737 规定的测试/演示用保留 IP 映射（防止真实内网拓扑与设备 MAC 泄露）
                    "00:11:22:33:44:55": "192.0.2.100",
                    "aa:bb:cc:dd:ee:ff": "192.0.2.200"
                };
                ip = mockIps[mac];
            }
            if (ip) {
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,192.168.0.0/16)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,10.0.0.0/8)),DIRECT`);
                ruleLines.push(`  - AND,((SRC-IP-CIDR,${ip}/32),(IP-CIDR,172.16.0.0/12)),DIRECT`);
                
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

        // 构造加速策略组
        const groupLines = ["# === GAME GROUP START ==="];
        if (gameMacs.length > 0) {
            groupLines.push(`  - {name: 🎮 游戏加速, type: select, proxies: [⚡ 游戏自动测速, 🚀 节点选择, 👑 高级节点, DIRECT], use: [${providerName}], filter: "(?i)(IPLC|IEPL|game|游戏)"}`);
            groupLines.push("  - {name: ⚡ 游戏自动测速, type: url-test, url: http://ctest.cdn.nintendo.net/, interval: 300, tolerance: 30, include-all: true, filter: \"(?i)(IPLC|IEPL|game|游戏)\"}");
        }
        groupLines.push("# === GAME GROUP END ===");
        
        try {
            // 1. 备份当前正常运行的配置文件
            await SshService.runRemoteCommand('cp -f /data/ShellCrash/yamls/config.yaml /tmp/config.yaml.bak');
            
            // 2. 写入临时游戏加速规则与策略组
            await SshService.runRemoteCommand('rm -f /tmp/game_rules.txt /tmp/game_group.txt');
            for (const line of ruleLines) {
                await SshService.runRemoteCommand(`echo '${line}' >> /tmp/game_rules.txt`);
            }
            for (const line of groupLines) {
                await SshService.runRemoteCommand(`echo '${line}' >> /tmp/game_group.txt`);
            }
            
            // 3. 将临时规则与策略组写入 config.yaml，前置清理旧的标记段
            await SshService.runRemoteCommand("sed -i '/# === GAME ACC START ===/,/# === GAME ACC END ===/d' /data/ShellCrash/yamls/config.yaml");
            await SshService.runRemoteCommand("sed -i '/# === GAME GROUP START ===/,/# === GAME GROUP END ===/d' /data/ShellCrash/yamls/config.yaml");
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
            // 重构为使用 ClashService 进行热重载或使用 curl
            await SshService.runRemoteCommand(`curl -s -X PUT -d '{"path": "/data/ShellCrash/yamls/config.yaml"}' http://127.0.0.1:${config.ports.clash}/configs?force=true`);
            Logger.info('RulesEngine', 'NAS端规则同步与 ClashMeta 重载指令下发成功！');
        } catch (err) {
            Logger.error('RulesEngine', 'Clash 规则配置文件远程更新异常', err);
            throw err;
        }
    }
}

module.exports = RulesEngine;
