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
let lastUpdateKey = '';               // 最近一次规则请求参数指纹
let lastUpdateAt = 0;                 // 最近一次规则请求完成时间
let updateInFlight = false;           // 最近一次规则更新是否仍在执行
const RULES_MIN_INTERVAL_MS = 10000;  // 相同参数的重复请求合并窗口

function _stableMacKey(gameMacs = [], aiMacs = [], proxyMacs = []) {
    return [gameMacs, aiMacs, proxyMacs]
        .map(arr => [...arr].sort().join(','))
        .join('|');
}

// 通用 hard-timeout 包装：给规则注入串行队列强加 wall-clock 上限，
// 避免任何一次 SSH/文件 IO hang 导致后续所有规则更新永久排队
function withHardTimeout(promise, ms, tag) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} 超过 ${ms}ms 硬超时`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// 去重日志：防止每次调用 modifyConfigText 时打印重复的 dns/sniffer 注入消息
const _loggedConfigFeatures = new Set();

function _logOnce(key, level, tag, msg) {
    if (!_loggedConfigFeatures.has(key)) {
        _loggedConfigFeatures.add(key);
        Logger[level](tag, msg);
    }
}

class RulesEngine {
    // 内存改写配置的纯函数，解耦 SSH 和文件 IO，方便单元测试
    static modifyConfigText(currentConfig, gameMacs = [], aiMacs = [], gameIps = []) {
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

        // 2c. 强制重写或注入 max-connections 限制（限制并发以防路由器 OOM）
        let maxConnIdx = configLines.findIndex(line => line.trim().startsWith('max-connections:'));
        if (maxConnIdx !== -1) {
            configLines[maxConnIdx] = 'max-connections: 512';
        } else {
            let insertAfter = configLines.findIndex(line => line.trim().startsWith('tproxy-port:'));
            if (insertAfter === -1) insertAfter = configLines.findIndex(line => line.trim().startsWith('allow-lan:'));
            if (insertAfter !== -1) {
                configLines.splice(insertAfter + 1, 0, 'max-connections: 512');
            }
        }

        // 2d. 强制重写或注入 memory-limit、gc-interval 和 log-level（强制触发高频 GC，防止运存跑满）
        let memLimitIdx = configLines.findIndex(line => line.trim().startsWith('memory-limit:'));
        if (memLimitIdx !== -1) {
            configLines[memLimitIdx] = 'memory-limit: 150MB';
        } else {
            let insertAfter = configLines.findIndex(line => line.trim().startsWith('max-connections:'));
            if (insertAfter !== -1) {
                configLines.splice(insertAfter + 1, 0, 'memory-limit: 150MB');
            }
        }

        let gcIdx = configLines.findIndex(line => line.trim().startsWith('gc-interval:'));
        if (gcIdx !== -1) {
            configLines[gcIdx] = 'gc-interval: 20s';
        } else {
            let insertAfter = configLines.findIndex(line => line.trim().startsWith('memory-limit:'));
            if (insertAfter !== -1) {
                configLines.splice(insertAfter + 1, 0, 'gc-interval: 20s');
            }
        }

        let logLevelIdx = configLines.findIndex(line => line.trim().startsWith('log-level:'));
        if (logLevelIdx !== -1) {
            configLines[logLevelIdx] = 'log-level: warning';
        } else {
            let insertAfter = configLines.findIndex(line => line.trim().startsWith('gc-interval:'));
            if (insertAfter !== -1) {
                configLines.splice(insertAfter + 1, 0, 'log-level: warning');
            }
        }
 
       // 3. 强制将 external-controller 的端口设置为 config.ports.clash (默认 9999)
        // 2e. 注入全局性能优化参数（tcp-concurrent 提升多连接下载、unified-delay 统一延迟计量、find-process-mode 关闭容器进程匹配、keep-alive-interval 防止长连接被 NAT 断开）
        const globalOpts = [
            ['tcp-concurrent', 'true'],
            ['unified-delay', 'true'],
            ['find-process-mode', 'off'],
            ['keep-alive-interval', '30'],
            ['global-client-fingerprint', 'chrome'],
        ];
        let globalInsertAfter = configLines.findIndex(line => line.trim().startsWith('log-level:'));
        if (globalInsertAfter === -1) globalInsertAfter = configLines.findIndex(line => line.trim().startsWith('max-connections:'));
        for (const [key, val] of globalOpts) {
            const existingIdx = configLines.findIndex(line => line.trim().startsWith(`${key}:`));
            if (existingIdx !== -1) {
                configLines[existingIdx] = `${key}: ${val}`;
            } else if (globalInsertAfter !== -1) {
                configLines.splice(globalInsertAfter + 1, 0, `${key}: ${val}`);
                globalInsertAfter++;
            }
        }

        // 2f. 注入 profile（持久化节点选择，防 Clash 重启丢失）和 grpc-opts（gRPC 保活防 NAT 断连）
        if (!currentConfig.includes('\nprofile:')) {
            configLines.splice(globalInsertAfter + 1, 0, 'profile:', '  store-selected: true', '  store-fake-ip: true');
            globalInsertAfter += 3;
        } else {
            let profIdx = configLines.findIndex(line => line.trim() === 'profile:');
            if (profIdx !== -1) {
                if (!configLines.slice(profIdx, profIdx + 5).some(l => l.includes('store-selected'))) {
                    configLines.splice(profIdx + 1, 0, '  store-selected: true');
                }
                if (!configLines.slice(profIdx, profIdx + 5).some(l => l.includes('store-fake-ip'))) {
                    configLines.splice(profIdx + 1, 0, '  store-fake-ip: true');
                }
            }
        }
        if (!currentConfig.includes('\ngrpc-opts:')) {
            configLines.splice(globalInsertAfter + 1, 0, 'grpc-opts:', '  grpc-keepalive: 30s');
            globalInsertAfter += 2;
        }

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
                    '    - 114.114.114.114',
                    '    - 223.5.5.5',
                    '    - 119.29.29.29',
                    '  nameserver-policy:',
                    '    +.srv.nintendo.net: [8.8.8.8, 223.5.5.5]',
                    '    +.download.nintendo.net: [8.8.8.8, 223.5.5.5]',
                    '  fallback:',
                    '    - 8.8.8.8',
                    '    - 1.1.1.1',
                    '  fallback-filter:',
                    '    geoip: true',
                    '    geoip-code: CN',
                    '  store-fake-ip: true',
                    // NAT/联机关键域名需要真实 IP（Switch P2P），CDN 用 Fake-IP 走直连
                    '  fake-ip-filter:',
                    '    - api.accounts.nintendo.com',
                    '    - accounts.nintendo.com',
                    '    - receive-lp1.dg.srv.nintendo.net',
                    '    - npln.srv.nintendo.net',
                    '    - +.nintendowifi.net',
                    '    - +.weixinbridge.com',
                    '    - +.weixin.qq.com',
                    '    - +.servicewechat.com',
                    '    - +.wechat.com',
                    '    - +.wechatpay.com',
                    '    - +.tenpay.com',
                    '    - +.wechatos.net',
                    '  cache-size: 1000'
                );
            }
        }

        // 4.1b 如果已存在 sniffer，整体替换为增强配置（force-dns-mapping + skip-domain）
        if (currentConfig.includes('\nsniffer:')) {
            let snifferStart = -1, snifferEnd = -1, inSnifferBlock = false;
            for (let i = 0; i < configLines.length; i++) {
                const line = configLines[i].trim();
                if (line.startsWith('sniffer:')) {
                    inSnifferBlock = true; snifferStart = i; snifferEnd = i; continue;
                }
                if (inSnifferBlock && line.length > 0 && !configLines[i].startsWith(' ') && !configLines[i].startsWith('	') && !line.startsWith('#')) {
                    break;
                }
                if (inSnifferBlock) snifferEnd = i;
            }
            if (snifferStart >= 0) {
                configLines.splice(snifferStart, snifferEnd - snifferStart + 1,
                    'sniffer:',
                    '  enable: true',
                    '  force-dns-mapping: true',
                    '  parse-pure-ip-address: true',
                    '  override-destination: false',
                    '  skip-domain:',
                    '    - +.nintendowifi.net'
                );
            }
        }

        // 4.2 注入缺少的 dns 和 sniffer 配置段
        const hasSniffer = currentConfig.includes('\nsniffer:');
        let insertIdx = configLines.findIndex(line => line.trim().startsWith('mixed-port:'));
        
        if (insertIdx !== -1) {
            if (!hasDns) {
                _logOnce("dns_inject", "info", "RulesEngine", "检测到 Clash 配置文件未开启 dns，正在内存中自动注入...");


                const dnsLines = [
                    'dns:',
                    '  enable: true',
                    `  listen: 0.0.0.0:${config.ports.dns}`,
                    '  enhanced-mode: fake-ip',
                    '  fake-ip-range: 198.18.0.1/16',
                    '  prefer-h3: false',
                    '  nameserver:',
                    '    - 114.114.114.114',
                    '    - 223.5.5.5',
                    '    - 119.29.29.29',
                    '  nameserver-policy:',
                    '    +.srv.nintendo.net: [8.8.8.8, 223.5.5.5]',
                    '    +.download.nintendo.net: [8.8.8.8, 223.5.5.5]',
                    '  fallback:',
                    '    - 8.8.8.8',
                    '    - 1.1.1.1',
                    '  fallback-filter:',
                    '    geoip: true',
                    '    geoip-code: CN',
                    '  store-fake-ip: true',
                // NAT/联机关键域名需要真实 IP（Switch P2P），CDN 用 Fake-IP 走直连
                '  fake-ip-filter:',
                '    - api.accounts.nintendo.com',
                '    - accounts.nintendo.com',
                '    - receive-lp1.dg.srv.nintendo.net',
                '    - npln.srv.nintendo.net',
                '    - +.nintendowifi.net',
                '    - +.weixinbridge.com',
                '    - +.weixin.qq.com',
                '    - +.servicewechat.com',
                '    - +.wechat.com',
                '    - +.wechatpay.com',
                '    - +.tenpay.com',
                '    - +.wechatos.net',
                    '  cache-size: 1000'
        ];
                configLines.splice(insertIdx + 1, 0, ...dnsLines);
                insertIdx += dnsLines.length;
            }
            
            if (!hasSniffer) {
                _logOnce("sniffer_inject", "info", "RulesEngine", "检测到 Clash 配置文件未开启 sniffer，正在内存中自动注入...");

               const snifferLines = [
                   'sniffer:',
                   '  enable: true',
                    '  force-dns-mapping: true',
                    '  parse-pure-ip-address: true',
                    '  override-destination: false',
                    '  skip-domain:',
                    '    - +.nintendowifi.net'
               ];
                configLines.splice(insertIdx + 1, 0, ...snifferLines);
            }
        }

        // 4.3 已移除 AdBlock 广告拦截配置块（YAGNI 极简稳定性优化）

        // 5. 清理旧 of AI 分流规则
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
            if (trimmed.includes('🎮 游戏下载') && !trimmed.includes('{name:')) return false;
            return true;
        });

        // 5b-2. 去重：移除订阅模板中已存在的 Nintendo 游戏域名规则（防止重复匹配）
        {
            const nintendoDomains = [
                'npln.srv.nintendo.net', 'ctest.cdn.nintendo.net',
                'bugyo.hac.lp1.eshop.nintendo.net',
                'api.accounts.nintendo.com', 'accounts.nintendo.com',
                'ec.nintendo.net', 'ec.nintendo.com', 'nintendo.com.hk',
                'atlas-content.nintendo.net',
                'atum.download.nintendo.net', 'hac.lp1.d4c.nintendo.net',
                'atum-ec.nintendo.net', 'd4c.srv.nintendo.net', 'penne.srv.nintendo.net',
                'baas.nintendo.com', 'dg.srv.nintendo.net', 'er.srv.nintendo.net',
                'dragons.nintendo.net', 'five.nintendo.net'
            ];
            // 只清理 rules: 段内的重复行（避免误删 dns.fake-ip-filter 等配置段的 Nintendo 域名）
            let inRulesSection = false;
            configLines = configLines.filter(line => {
                const trimmed = line.trim();
                if (trimmed === 'rules:') { inRulesSection = true; return true; }
                if (!inRulesSection) return true;
                if (trimmed.length > 0 && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
                    if (line === trimmed) inRulesSection = false; // 进入下一个顶层段
                    return true;
                }
                return !nintendoDomains.some(d => trimmed.includes(d));
            });
        }

        // 5c. 清理旧的国内直连规则
        let inCnDirect = false;
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('CN DIRECT RULES START')) {
                inCnDirect = true;
                return false;
            }
            if (trimmed.includes('CN DIRECT RULES END')) {
                inCnDirect = false;
                return false;
            }
            return !inCnDirect;
        });

        // 5d. 注入国内主流 App 域名直连规则（始终注入，受益所有代理设备）
        {
            const rulesIdx = configLines.findIndex(line => line.trim() === 'rules:');
            if (rulesIdx === -1) {
                // 订阅模板不含 rules: 段，自动追加
                Logger.info('RulesEngine', '订阅模板未包含 rules: 段，自动追加');
                configLines.push('rules:', '- GEOIP,CN,DIRECT', '- MATCH,🚀 节点选择');
            }
            {
                const actualIdx = configLines.findIndex(line => line.trim() === 'rules:');
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
                    // 微信/公众号/小程序/支付相关域名
                    '- DOMAIN-SUFFIX,weixinbridge.com,DIRECT',
                    '- DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
                    '- DOMAIN-SUFFIX,servicewechat.com,DIRECT',
                    '- DOMAIN-SUFFIX,wechat.com,DIRECT',
                    '- DOMAIN-SUFFIX,wechatpay.com,DIRECT',
                    '- DOMAIN-SUFFIX,tenpay.com,DIRECT',
                    '- DOMAIN-SUFFIX,wechatos.net,DIRECT',
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
                    // 电商图片与业务 CDN — 阿里/闲鱼/淘宝、京东、拼多多
                    '- DOMAIN-SUFFIX,alicdn.com,DIRECT',
                    '- DOMAIN-SUFFIX,aliyuncs.com,DIRECT',
                    '- DOMAIN-SUFFIX,taobao.com,DIRECT',
                    '- DOMAIN-SUFFIX,tmall.com,DIRECT',
                    '- DOMAIN-SUFFIX,alibaba.com,DIRECT',
                    '- DOMAIN-SUFFIX,alipay.com,DIRECT',
                    '- DOMAIN-SUFFIX,alipayobjects.com,DIRECT',
                    '- DOMAIN-SUFFIX,tbcache.com,DIRECT',
                    '- DOMAIN-SUFFIX,idlefish.com,DIRECT',
                    '- DOMAIN-SUFFIX,1688.com,DIRECT',
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
                configLines.splice(actualIdx + 1, 0, ...ruleLines);
            }

        // 5e. 清理旧的流媒体规则
        let inStreaming = false;
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('STREAMING RULES START')) {
                inStreaming = true;
                return false;
            }
            if (trimmed.includes('STREAMING RULES END')) {
                inStreaming = false;
                return false;
            }
            return !inStreaming;
        });

        // 5f. 注入流媒体域名规则（YouTube/X，走高带宽非 gRPC 节点）
        {
            const actualIdx = configLines.findIndex(line => line.trim() === 'rules:');
            if (actualIdx !== -1) {
                let rulesIndent = '  ';
                for (let i = actualIdx + 1; i < configLines.length; i++) {
                    const line = configLines[i];
                    if (line.trim().startsWith('-')) {
                        const match = line.match(/^(\s*)-/);
                        if (match) rulesIndent = match[1];
                        break;
                    }
                    if (line.trim() !== '' && !line.trim().startsWith('#')) break;
                }
                const streamRuleLines = [
                    '# === STREAMING RULES START ===',
                    '- DOMAIN-SUFFIX,youtube.com,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,googlevideo.com,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,ytimg.com,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,youtu.be,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,x.com,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,twitter.com,🎬 流媒体加速',
                    '- DOMAIN-SUFFIX,twimg.com,🎬 流媒体加速',
                    '# === STREAMING RULES END ===',
                ];
                const streamLines = streamRuleLines.map(l => `${rulesIndent}${l}`);
                configLines.splice(actualIdx + 1, 0, ...streamLines);
            }
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
                    '- DOMAIN-SUFFIX,client-api.arkoselabs.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,auth0.openai.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,featuregates.org,🤖 AI强化',
                    '- DOMAIN-SUFFIX,statsig.api.aws.iovation.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,events.statsigapi.net,🤖 AI强化',
                    '- DOMAIN-SUFFIX,claude.ai,🤖 AI强化',
                    '- DOMAIN-SUFFIX,anthropic.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,claude.usercontent.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,cdn.usefathom.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,perplexity.ai,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gemini.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,generativelanguage.googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,ai.google.dev,🤖 AI强化',
                    '- DOMAIN-SUFFIX,makersuite.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,aistudio.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,deepmind.google,🤖 AI强化',
                    '- DOMAIN-SUFFIX,deepmind.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,generativeai.google,🤖 AI强化',
                    '- DOMAIN-KEYWORD,colab,🤖 AI强化',
                    '- DOMAIN-SUFFIX,developer.google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,content-push.googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,firebase.googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,google.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,googleapis.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gstatic.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,googleusercontent.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,gvt1.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,ggpht.com,🤖 AI强化',
                    '- DOMAIN-SUFFIX,android.com,🤖 AI强化',
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
                    // 联机匹配、商城与连通测速走游戏加速（低延迟专线）
                   '- DOMAIN-SUFFIX,npln.srv.nintendo.net,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,ctest.cdn.nintendo.net,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,bugyo.hac.lp1.eshop.nintendo.net,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,api.accounts.nintendo.com,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,accounts.nintendo.com,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,ec.nintendo.net,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,ec.nintendo.com,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,nintendo.com.hk,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,atlas-content.nintendo.net,🎮 游戏加速',
                   '- DOMAIN-SUFFIX,baas.nintendo.com,🎮 游戏加速',
                    // 大流量游戏/补丁下载走游戏下载组（高带宽 Reality/直连节点）
                    '- DOMAIN-SUFFIX,atum.download.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,hac.lp1.d4c.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,atum-ec.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,d4c.srv.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,penne.srv.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,dg.srv.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,er.srv.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,dragons.nintendo.net,🎮 游戏下载',
                    '- DOMAIN-SUFFIX,five.nintendo.net,🎮 游戏下载',
                   '- DOMAIN-SUFFIX,speed.cloudflare.com,🎮 游戏下载',
                   '# === GAME RULES END ==='
               ];

                const ruleLines = gameRuleLines.map(line => `${rulesIndent}${line}`);
                configLines.splice(rulesIdx + 1, 0, ...ruleLines);
            }
        }

        // 6c. 清理旧的游戏设备 SRC-IP-CIDR 规则（防止 IP 变更后残留）
        configLines = configLines.filter(line => {
            const trimmed = line.trim();
            if (trimmed.includes('GAME SRC-IP RULES')) return false;
            return true;
        });

        // 6d. 注入游戏设备 SRC-IP-CIDR 规则（兜底走下载组：联机域名已由 DOMAIN-SUFFIX 精确匹配到游戏加速，未识别流量以下载为主）
        if (gameIps.length > 0) {
            const matchIdx = configLines.findIndex(line => line.trim().startsWith('- MATCH,'));
            if (matchIdx !== -1) {
                let rulesIndent = ' ';
                const matchLine = configLines[matchIdx];
                const indentMatch = matchLine.match(/^(\s*)-/);
                if (indentMatch) rulesIndent = indentMatch[1];
                
                const ipRules = [
                    `# === GAME SRC-IP RULES START ===`,
                    ...gameIps.map(ip => `${rulesIndent}- SRC-IP-CIDR,${ip}/32,🎮 游戏下载`),
                    `# === GAME SRC-IP RULES END ===`,
                ];
                // 注入在 MATCH 之前（GEOIP,CN 之后），确保国内流量仍直连
                configLines.splice(matchIdx, 0, ...ipRules);
            }
        }

       // 7. 清理旧的代理组行（防止乱码重复注入）
       configLines = configLines.filter(line => {
           const trimmed = line.trim();
           if (trimmed.startsWith('-') && trimmed.includes('{name:')) {
               if (trimmed.includes('流媒体加速') || trimmed.includes('流媒体自动测速')) return false;
               if (trimmed.includes('AI强化') || trimmed.includes('AI自动测速')) return false;
               if (trimmed.includes('游戏加速')) return false;
                if (trimmed.includes('游戏下载')) return false;
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
               groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_ACC}', type: select, proxies: ['${actualNodeSelect}', 'DIRECT'], use: [${providerName}], filter: "(?i)(Japan|Korea|Taiwan|Singapore|Hongkong|日本|韩国|韓國|台灣|台湾|香港|新加坡|JP|KR|TW|SG|HK)"}`);
                groupLines.push(`${indent}- {name: '${PROXY_GROUPS.GAME_DOWNLOAD}', type: select, proxies: ['${actualNodeSelect}', 'DIRECT'], use: [${providerName}], filter: "(?i)(Japan|Korea|Taiwan|Singapore|Hongkong|日本|韩国|韓國|台灣|台湾|香港|新加坡|JP|KR|TW|SG|HK)"}`);
           }

            if (aiMacs.length > 0) {
                const aiGroupProxies = [actualNodeSelect];
                const groupMatches = currentConfig.matchAll(/name:\s*['"]?([^\n'",{}]*(?:自动|Auto|节点)[^\n'",{}]*)['"]?/gi);
                for (const match of groupMatches) {
                    const gName = match[1].trim();
                    if (gName !== PROXY_GROUPS.AI_BOOST &&
                        gName !== PROXY_GROUPS.GAME_ACC &&
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

            // Streaming proxy group (always injected - non-gRPC high-bandwidth for video/X)
            groupLines.push(`${indent}- {name: '${PROXY_GROUPS.STREAMING_SPEEDTEST}', type: url-test, tolerance: 100, interval: 600, use: [${providerName}], filter: \"(?i)(原生|直連)\"}`);
            groupLines.push(`${indent}- {name: '${PROXY_GROUPS.STREAMING}', type: select, proxies: ['${PROXY_GROUPS.STREAMING_SPEEDTEST}', '${actualNodeSelect}'], use: [${providerName}], filter: \"(?i)(原生|直連)\"}`);

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
        const requestKey = _stableMacKey(gameMacs, aiMacs, proxyMacs);
        if (lastUpdateKey === requestKey && Date.now() - lastUpdateAt < RULES_MIN_INTERVAL_MS) {
            Logger.debug('RulesEngine', `相同规则参数在 ${RULES_MIN_INTERVAL_MS / 1000}s 内已更新，合并重复请求`);
            return true;
        }

        // 单次规则注入含多次 SSH + 热重载，5 分钟硬上限足够；到点熔断以避免链路死锁
        const RULES_HARD_TIMEOUT_MS = 300000;
        const chained = updatePromise.then(async () => {
            updateInFlight = true;
            Logger.info('RulesEngine', `设备统计: 代理${proxyMacs.length}个, 游戏${gameMacs.length}个, AI${aiMacs.length}个 (排队执行中)`);
            Logger.info('RulesEngine', '分流策略：国内域名→DIRECT, GEOIP,CN→DIRECT, MATCH→代理');

            // 1. 并行获取路由器配置和 DHCP 租约（减少一次串行 SSH RTT）
            let currentConfig = '';
            let leasesOutput = '';
            try {
                const [configResult, leasesResult] = await Promise.all([
                    SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml'),
                    SshService.runRemoteCommand('cat /tmp/dhcp.leases 2>/dev/null || cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /data/dhcp.leases 2>/dev/null || /tmp/generate_dhcp_leases.sh 2>/dev/null || cat /proc/net/arp 2>/dev/null || echo ""').catch(() => '')
                ]);
                currentConfig = configResult;
                leasesOutput = leasesResult;
            } catch (err) {
                Logger.error('RulesEngine', '获取路由器配置或 DHCP 租约失败', err);
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
                // 解析 DHCP 租约，获取游戏设备的当前 IP
                let gameIps = [];
                if (leasesOutput.trim()) {
                    const leaseLines = leasesOutput.split('\n');
                    const dhcpLeases = {};
                    for (const line of leaseLines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 3) dhcpLeases[parts[1].toLowerCase()] = parts[2];
                    }
                    gameIps = gameMacs.map(mac => dhcpLeases[mac.toLowerCase()]).filter(Boolean);
                }
                finalConfig = RulesEngine.modifyConfigText(currentConfig, gameMacs, aiMacs, gameIps);
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

            // 提前对比：如果在内存中修改后的配置与路由器当前的配置完全一致，
            // 且当前 Clash API 能响应，则安全进行零延迟拦截。
            // 否则（例如 Clash 挂了或未绑定），必须放行执行下发配置和冷重启拉起自愈流程。
            let isClashResponsive = false;
            try {
                const version = await ClashService.getVersion(1500);
                if (version && version.version) {
                    isClashResponsive = true;
                }
            } catch (e) {
                isClashResponsive = false;
            }

            if (currentConfig === finalConfig && isClashResponsive) {
                Logger.info('RulesEngine', '⚡️ 零延迟拦截：配置内容未发生实质变化且内核在线响应，跳过上传、校验与热重载流程。');
                return true;
            }

            try {
                // 将配置写到容器本地临时文件
                const localWorkFile = `/tmp/local_config_work_${uniqueId}.yaml`;
                fs.writeFileSync(localWorkFile, finalConfig);
                
                // 将本地文件上传到路由器临时目录
                await SshService.uploadFileLocal(localWorkFile, workFile);
                fs.unlinkSync(localWorkFile);

                // 4. 跳过本地 YAML 校验——配置已通过 modifyConfigText 语法保证，
                // Clash 的 hotReload (PUT /configs) 机制会自行做最终权威校验和热重载
                /*
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
                */

                // 把工作文件安全写回 /data
                await SshService.runRemoteCommand(`cp -f ${workFile} /data/ShellCrash/config.yaml`);
                await SshService.runRemoteCommand(`rm -f ${workFile}`);

                // 执行配置平滑热重载 (Hot Reload)
                await SshService.reloadShellCrashSecurely('/data/ShellCrash/config.yaml');
                SshService.updateLastRestartTime();

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
        }).finally(() => {
            updateInFlight = false;
            lastUpdateKey = requestKey;
            lastUpdateAt = Date.now();
        });

        // updatePromise 存储 hard-timeout 包装后的 promise，且必须最终 resolve（自复位），
        // 避免一次失败/超时让后续所有 updateClashRules 永久排队
        updatePromise = withHardTimeout(chained, RULES_HARD_TIMEOUT_MS, 'updateClashRules').catch(err => {
            Logger.error('RulesEngine', `规则注入链路熔断：${err.message}，自复位以便下次可继续排队`);
            // 不 rethrow：链路复位为 resolved
        });
        return chained; // 调用方拿到原始 promise（保留真实错误传播）
    }
}

// 规则注入完成后复位去重日志，以便下次启动时重新记录
RulesEngine.resetLoggedFeatures = () => { _loggedConfigFeatures.clear(); };

module.exports = RulesEngine;
