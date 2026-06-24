const express = require('express');
const os = require('os');
const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('../services/sshService');
const ClashService = require('../services/clashService');
const StorageCleanupService = require('../services/storageCleanupService');
const ClashApiProxy = require('../utils/clashApiProxy');
const ProxyGroupDetector = require('../utils/proxyGroupDetector');
const ConfigVersionManager = require('../services/configVersionManager');
const ChangelogManager = require('../services/changelogManager');
const { ROUTER_PATHS } = require('../constants');

const router = express.Router();

// 辅助：获取宿主机局域网 IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

let cachedVersion = null;
let cachedMode = null;
let cachedMainGroupName = null;

// 辅助：检测或返回缓存的主代理组名
async function getMainGroupName() {
    if (cachedMainGroupName) return cachedMainGroupName;
    try {
        const configContent = await SshService.runRemoteCommand('cat /data/ShellCrash/config.yaml');
        const selectMatch = configContent.match(/name:\s*['"]?([^'"\n]*(?:选择节点|节点选择))['"]?/);
        if (selectMatch && selectMatch[1]) {
            cachedMainGroupName = selectMatch[1];
            return cachedMainGroupName;
        }
    } catch (e) {
        Logger.debug('Gateway', `检测主代理组名异常: ${e.message}`);
    }
    return '🚀 选择节点';
}

router.clearMainGroupCache = () => {
    cachedMainGroupName = null;
    cachedMode = null;
    cachedVersion = null;
    Logger.info('Gateway', '已清除网关配置及代理组名缓存');
};

// 辅助：获取 Clash 当前代理节点信息（解析代理组链，返回实际物理节点）
async function getCurrentNodeInfo() {
    try {
        const mainGroupName = await getMainGroupName();
        // 通过 Clash API 解析代理组链（使用与 /api/nodes 相同的数据源 ClashService）
        const proxiesData = await ClashService.getProxies();
        if (proxiesData && proxiesData.proxies) {
            const realNode = ProxyGroupDetector.getRealPhysicalNode(proxiesData.proxies, mainGroupName);
            return {
                name: realNode.name,
                delay: realNode.delay || 0,
                mainGroupName
            };
        }
        return { name: mainGroupName, delay: 0, mainGroupName };
    } catch (e) {
        Logger.debug('Gateway', `查询当前节点异常: ${e.message}`);
        return { name: '未知', delay: 0, mainGroupName: '未知' };
    }
}

// 1. 获取网关/代理运行状态
router.get('/status', async (req, res) => {
    try {
        // 1. 并行：SSH 系统统计 + 代理节点信息（减少总延迟）
        const statsCmd = `pid=\$(pidof mihomo || pidof Clash || pidof CrashCore || pgrep -x mihomo || pgrep -x Clash || pgrep -x CrashCore); echo "PID:\$pid"; if [ -n "\$pid" ]; then echo "CLASH_RAW:\$(awk '{print int(\$1)}' /proc/uptime 2>/dev/null):\$(awk '{print \$22}' /proc/\$pid/stat 2>/dev/null)"; cat /proc/\$pid/status | grep VmRSS; timeout 1 top -b -n 1 2>/dev/null | grep -v grep | grep -E "mihomo|Clash|CrashCore" | head -n 1; fi; cat /proc/meminfo | grep MemTotal; df -m /data | tail -n 1`;
        const nodeInfoPromise = getCurrentNodeInfo();
        const statsOutput = await SshService.runRemoteCommand(statsCmd);

        // 解析输出
        const lines = statsOutput.split('\n');
        let pid = '';
        let memory = '0 MB';
        let cpu = '0.0%';
        let totalMemory = '1024 MB';
        let uptime = 0;
        let diskUsed = '0';
        let diskTotal = '20';

        // 解析磁盘占用
        const dfLine = lines.find(l => l.includes('/data') && !l.includes('df') && !l.includes('mihomo') && !l.includes('Clash') && !l.includes('CrashCore'));
        if (dfLine) {
            const dfParts = dfLine.trim().split(/\s+/);
            if (dfParts.length >= 4) {
                diskTotal = dfParts[1].trim();
                diskUsed = dfParts[2].trim();
            }
        }

        // 解析 PID
        const pidLine = lines.find(l => l.startsWith('PID:'));
        if (pidLine) {
            pid = pidLine.substring(4).trim();
        }
        const isRunning = pid.length > 0;

        if (isRunning) {
            // 解析 VmRSS
            const rssLine = lines.find(l => l.includes('VmRSS:'));
            if (rssLine) {
                const match = rssLine.match(/VmRSS:\s+(\d+)\s+kB/i);
                if (match) {
                    memory = `${Math.round(parseInt(match[1], 10) / 1024)} MB`;
                }
            }

            // 解析 CPU
            const cpuLine = lines.find(l => (l.includes('mihomo') || l.includes('Clash') || l.includes('CrashCore')) && !l.startsWith('PID:'));
            if (cpuLine) {
                const parts = cpuLine.trim().split(/\s+/);
                const percentFields = parts.filter(p => p.includes('%'));
                if (percentFields.length > 0) {
                    cpu = percentFields[percentFields.length - 1];
                } else if (parts.length >= 2) {
                    const val = parts[parts.length - 2];
                    if (/^\d+$/.test(val)) {
                        cpu = `${val}%`;
                    }
                }
            }
        }

        // 解析 MemTotal
        const memTotalLine = lines.find(l => l.includes('MemTotal:'));
        if (memTotalLine) {
            const match = memTotalLine.match(/MemTotal:\s+(\d+)\s+kB/i);
            if (match) {
                totalMemory = `${Math.round(parseInt(match[1], 10) / 1024)} MB`;
            }
        }

        // 解析 Clash 进程启动时长 (CLASH_RAW:sysUp:startTicks)
        const clashRawLine = lines.find(l => l.startsWith('CLASH_RAW:'));
        if (clashRawLine) {
            const parts = clashRawLine.split(':');
            const sysUp = parseInt(parts[1], 10);
            const startTicks = parseInt(parts[2], 10);
            if (!isNaN(sysUp) && !isNaN(startTicks) && startTicks > 0 && sysUp > 0) {
                const CLK_TCK = 100;
                uptime = Math.max(0, Math.round(sysUp - startTicks / CLK_TCK));
            }
        }

        if (!isRunning) {
            return res.json({
                status: 'success',
                running: false,
                currentNode: '已关闭',
                latency: 0,
                version: '未知',
                mode: '未知',
                memory: '0 MB',
                totalMemory,
                diskUsed,
                diskTotal,
                cpu: '0.0%',
                uptime: 0,
                localIp: getLocalIP(),
                port: config.port
            });
        }

        // 2. 异步获取 Clash API 版本与模式信息（使用SSH隧道，带缓存优化）
        let version = '未知';
        let mode = '未知';
        let currentNode = '未知';
        let latency = 0;

        if (cachedVersion) {
            version = cachedVersion;
        } else {
            try {
                const vData = await ClashApiProxy.getVersion();
                version = vData.version || '未知';
                if (version !== '未知') cachedVersion = version;
            } catch (e) {
                Logger.debug('Gateway', '通过SSH获取Clash版本失败', e);
            }
        }

        if (cachedMode) {
            mode = cachedMode;
        } else {
            try {
                const cData = await ClashApiProxy.getConfigs();
                mode = cData.mode || '未知';
                if (mode !== '未知') cachedMode = mode;
            } catch (e) {
                Logger.debug('Gateway', '通过SSH获取Clash配置失败', e);
            }
        }

        try {
            const nodeInfo = await nodeInfoPromise;
            currentNode = nodeInfo.name;
            latency = nodeInfo.delay;
        } catch (e) {
            Logger.debug('Gateway', '获取当前节点失败', e);
        }

        res.json({
            status: 'success',
            running: true,
            currentNode,
            latency,
            version,
            mode,
            memory,
            totalMemory,
            diskUsed,
            diskTotal,
            cpu,
            uptime,
            localIp: getLocalIP(),
            port: config.port
        });
    } catch (err) {
        Logger.error('Gateway', '获取系统与代理状态失败', err);
        res.status(500).json({
            status: 'error',
            message: '无法连接到路由器或获取状态失败',
            details: err.stderr || err.message
        });
    }
});

// 2. 获取最近一次异常退出的详细日志内容
router.get('/error-log', async (req, res) => {
    try {
        const logOutput = await SshService.runRemoteCommand('[ -f /tmp/ShellCrash/ShellCrash.log ] && tail -n 40 /tmp/ShellCrash/ShellCrash.log || echo "当前无异常日志"');
        res.json({
            status: 'success',
            log: logOutput.trim()
        });
    } catch (err) {
        Logger.error('Gateway', '获取异常错误日志失败', err);
        res.status(500).json({
            status: 'error',
            message: '无法读取路由器端的日志文件',
            details: err.stderr || err.message
        });
    }
});

// 3. 获取所有策略组节点信息（用于顶层节点详情弹窗）
router.get('/nodes', async (req, res) => {
    try {
        const nocache = req.query.nocache === '1';
        const proxiesData = await ClashService.getProxies(5000, nocache);
        const proxies = proxiesData.proxies || {};

        const mainGroup = ProxyGroupDetector.findMainProxyGroup(proxies);
        const mainGroupName = mainGroup?.name || '🚀 节点选择';

        // 辅助函数：安全获取节点信息
        const getNodeInfo = (proxies, nodeName) => {
            const nodeData = ProxyGroupDetector.getRealPhysicalNode(proxies, nodeName);
            return {
                name: nodeData?.name || nodeName || '未知',
                delay: nodeData?.delay || 0
            };
        };

        // 递归获取所有底层物理节点（排除策略组和虚拟节点）
        const getAllLeafNodes = (nameOrNames, visited = new Set()) => {
            if (Array.isArray(nameOrNames)) {
                let res = [];
                for (const n of nameOrNames) {
                    res = res.concat(getAllLeafNodes(n, visited));
                }
                return res;
            }
            const name = nameOrNames;
            if (!name || visited.has(name)) return [];
            visited.add(name);
            
            const p = proxies[name];
            if (!p) {
                return [name];
            }
            
            // 如果该节点是策略组（即含有 all 数组），递归向下查找
            if (p.all && Array.isArray(p.all)) {
                return getAllLeafNodes(p.all, visited);
            }
            return [name];
        };

        // 辅助函数：对物理节点列表进行精简与特征过滤，减少传输和渲染负担，防止 OOM
        const getSortedAndFilteredNodes = (allNames, currentSelectedNode, mode = 'proxy', limit = 30, returnAll = false) => {
            if (!allNames) return [];
            
            const filterOutGroups = [
                '⚡ 游戏自动测速', '🚀 节点选择', '🚀 选择节点', '👑 高级节点', 
                'DIRECT', 'GLOBAL', 'AI自动测速', '🤖 AI强化', '🎮 游戏加速',
                'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'
            ];
            
            let leafNames = getAllLeafNodes(allNames);
            leafNames = [...new Set(leafNames)];
            
            let nodes = leafNames
                .filter(name => !filterOutGroups.includes(name))
                .map(name => {
                    const p = proxies[name];
                    // 额外防守过滤：即便在展平后仍被认为是策略组的项也过滤掉
                    if (p && p.all && Array.isArray(p.all)) {
                        return null;
                    }
                    let delay = 0;
                    if (p && p.history && p.history.length > 0) {
                        const valid = p.history.filter(h => h.delay > 0);
                        delay = valid.length > 0 ? valid[valid.length - 1].delay : 0;
                    }
                    return { name, delay };
                })
                .filter(n => n !== null);

            // 模式特定的特殊过滤
            if (mode === 'ai') {
                // AI 模式过滤：不包含香港、直连、通用选择
                nodes = nodes.filter(node => {
                    const lowerName = node.name.toLowerCase();
                    return !lowerName.includes('hk') && 
                           !lowerName.includes('hongkong') && 
                           !lowerName.includes('香港') && 
                           !lowerName.includes('港');
                });
            } else if (mode === 'game') {
                // 游戏模式过滤：仅保留带有专线/游戏特征，或者延迟低于 120ms 的节点
                nodes = nodes.filter(node => {
                    const lowerName = node.name.toLowerCase();
                    const isGameKey = lowerName.includes('iplc') || 
                                     lowerName.includes('iepl') || 
                                     lowerName.includes('专线') || 
                                     lowerName.includes('game') || 
                                     lowerName.includes('游戏');
                    return isGameKey || (node.delay > 0 && node.delay < 120);
                });
            }

            // 分离存活节点和无测速死节点
            const aliveNodes = nodes.filter(n => n.delay > 0).sort((a, b) => a.delay - b.delay);
            const deadNodes = nodes.filter(n => n.delay === 0);

            // 主代理组如果没有传递 all=true，或者不是 'proxy' 模式，我们就截断
            const shouldLimit = (mode !== 'proxy') || !returnAll;
            
            let resultNodes = aliveNodes;
            if (shouldLimit) {
                resultNodes = aliveNodes.slice(0, limit);
            }
            
            // 确保当前选中的物理节点一定要在列表里，即使它不通或不在前 limit 个里
            const isCurrentInResult = resultNodes.some(n => n.name === currentSelectedNode);
            if (!isCurrentInResult && currentSelectedNode && !filterOutGroups.includes(currentSelectedNode)) {
                const p = proxies[currentSelectedNode];
                const isGroup = p && p.all && Array.isArray(p.all);
                if (!isGroup) {
                    const currentData = nodes.find(n => n.name === currentSelectedNode);
                    if (currentData) {
                        resultNodes.push(currentData);
                    } else {
                        resultNodes.push({ name: currentSelectedNode, delay: 0 });
                    }
                }
            }

            // 如果活的节点数量太少，可以从不通的节点里补齐，最多补到 limit 个，方便用户切换
            if (shouldLimit && resultNodes.length < limit && deadNodes.length > 0) {
                const needed = limit - resultNodes.length;
                resultNodes = resultNodes.concat(deadNodes.slice(0, needed));
            }
            
            return resultNodes;
        };

        const returnAll = req.query.all === 'true';
        const filterOutGroups = [
            '⚡ 游戏自动测速', '🚀 节点选择', '🚀 选择节点', '👑 高级节点', 
            'DIRECT', 'GLOBAL', 'AI自动测速', '🤖 AI强化', '🎮 游戏加速',
            'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'
        ];
        const proxyLeafNames = [...new Set(getAllLeafNodes(proxies[mainGroupName]?.all || []))];
        const proxyAllFiltered = proxyLeafNames.filter(name => !filterOutGroups.includes(name));
        const hasMore = proxyAllFiltered.length > 30 && !returnAll;

        const result = {
            proxy: {
                name: mainGroupName,
                now: proxies[mainGroupName]?.now || 'DIRECT',
                realNode: getNodeInfo(proxies, proxies[mainGroupName]?.now || 'DIRECT').name,
                delay: getNodeInfo(proxies, proxies[mainGroupName]?.now || 'DIRECT').delay,
                all: getSortedAndFilteredNodes(proxies[mainGroupName]?.all, proxies[mainGroupName]?.now, 'proxy', 30, returnAll),
                hasMore: hasMore
            },
            game: {
                name: '🎮 游戏加速',
                now: proxies['🎮 游戏加速']?.now || 'DIRECT',
                realNode: getNodeInfo(proxies, proxies['🎮 游戏加速']?.now || 'DIRECT').name,
                delay: getNodeInfo(proxies, proxies['🎮 游戏加速']?.now || 'DIRECT').delay,
                all: getSortedAndFilteredNodes(proxies['🎮 游戏加速']?.all, proxies['🎮 游戏加速']?.now, 'game', 20)
            },
            ai: {
                name: '🤖 AI强化',
                now: proxies['🤖 AI强化']?.now || 'DIRECT',
                realNode: getNodeInfo(proxies, proxies['🤖 AI强化']?.now || 'DIRECT').name,
                delay: getNodeInfo(proxies, proxies['🤖 AI强化']?.now || 'DIRECT').delay,
                all: getSortedAndFilteredNodes(proxies['🤖 AI强化']?.all, proxies['🤖 AI强化']?.now, 'ai', 20)
            }
        };

        res.json({
            status: 'success',
            proxies: result
        });
    } catch (err) {
        Logger.error('Gateway', '获取节点详情列表失败', err);
        res.status(500).json({
            status: 'error',
            message: '无法从 Clash 核心获取节点详情',
            details: err.message
        });
    }
});

// 4. 选择/切换特定的策略组节点（支持二次确认的手动切换）
router.post('/select', async (req, res) => {
    try {
        const { group, node } = req.body;
        if (!group || !node) {
            return res.status(400).json({ status: 'error', message: '缺少 group 或 node 参数' });
        }

        const success = await ClashService.selectProxyNode(group, node);
        if (success) {
            ClashService.testNodeDelay(node).catch(e =>
                Logger.debug('Gateway', '节点延迟测试失败', e)
            );
            res.json({ status: 'success' });
        } else {
            res.status(500).json({ status: 'error', message: 'Clash API 切换节点失败' });
        }
    } catch (err) {
        Logger.error('Gateway', '切换节点路由发生异常', err);
        res.status(500).json({ status: 'error', message: '切换节点失败', details: err.message });
    }
});

// 手动触发存储清理
router.post('/cleanup', async (req, res) => {
    try {
        Logger.info('Maintenance', '手动触发存储清理请求...');
        await StorageCleanupService.cleanupNow();
        res.json({
            status: 'success',
            message: '存储清理任务已完成'
        });
    } catch (err) {
        Logger.error('Maintenance', '存储清理失败', err);
        res.status(500).json({
            status: 'error',
            message: '存储清理失败',
            details: err.message
        });
    }
});

// 获取配置变更日志摘要
router.get('/changelog/summary', async (req, res) => {
    try {
        const summary = ChangelogManager.getSummary();
        res.json({
            status: 'success',
            data: summary
        });
    } catch (err) {
        Logger.error('Gateway', '获取变更日志摘要失败', err);
        res.status(500).json({
            status: 'error',
            message: '获取变更日志摘要失败',
            details: err.message
        });
    }
});

// 获取最近的配置变更记录
router.get('/changelog/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const changes = ChangelogManager.getRecentChanges(limit);
        res.json({
            status: 'success',
            data: { count: changes.length, changes }
        });
    } catch (err) {
        Logger.error('Gateway', '获取变更记录失败', err);
        res.status(500).json({
            status: 'error',
            message: '获取变更记录失败',
            details: err.message
        });
    }
});

// 列出可用的配置版本
router.get('/config/versions', async (req, res) => {
    try {
        const versions = ConfigVersionManager.listVersions();
        res.json({
            status: 'success',
            data: {
                count: versions.length,
                versions: versions.map(v => ({
                    index: v.index,
                    filename: v.filename,
                    size: v.size,
                    time: v.time
                }))
            }
        });
    } catch (err) {
        Logger.error('Gateway', '列出配置版本失败', err);
        res.status(500).json({
            status: 'error',
            message: '列出配置版本失败',
            details: err.message
        });
    }
});

// 恢复到指定配置版本
router.post('/config/restore', async (req, res) => {
    try {
        const { versionIndex } = req.body;
        if (versionIndex === undefined) {
            return res.status(400).json({
                status: 'error',
                message: '缺少 versionIndex 参数'
            });
        }

        Logger.info('Gateway', `正在恢复配置到版本索引: ${versionIndex}`);
        const success = ConfigVersionManager.restoreVersion(versionIndex, ROUTER_PATHS.CLASH_CONFIG);

        if (success) {
            // 触发Clash重新加载
            await SshService.runRemoteCommand(`curl -s -X PUT -d '{"path": "${ROUTER_PATHS.CLASH_CONFIG}"}' http://127.0.0.1:${config.ports.clash}/configs?force=true`);
            Logger.info('Gateway', '配置已恢复并重新加载');
            res.json({ status: 'success', message: '配置版本已恢复' });
        } else {
            res.status(500).json({
                status: 'error',
                message: '配置恢复失败'
            });
        }
    } catch (err) {
        Logger.error('Gateway', '配置恢复失败', err);
        res.status(500).json({
            status: 'error',
            message: '配置恢复失败',
            details: err.message
        });
    }
});

// 磁盘空间诊断和清理
router.get('/diagnostic/storage', async (req, res) => {
    try {
        const usage = await StorageCleanupService.getDiskUsage();
        res.json({
            status: 'success',
            diskUsage: usage,
            message: usage !== null ? `磁盘使用率: ${usage}%` : '无法获取磁盘使用率'
        });
    } catch (err) {
        Logger.error('Gateway', '磁盘诊断失败', err);
        res.status(500).json({
            status: 'error',
            message: '磁盘诊断失败',
            details: err.message
        });
    }
});

// 手动触发磁盘清理
router.post('/diagnostic/cleanup', async (req, res) => {
    try {
        const { level } = req.body;
        Logger.info('Gateway', `手动触发清理: level=${level}`);

        let cleanupFn;
        switch (level) {
            case 'basic':
                cleanupFn = () => StorageCleanupService.basicCleanup();
                break;
            case 'aggressive':
                cleanupFn = () => StorageCleanupService.aggressiveCleanup();
                break;
            case 'emergency':
                cleanupFn = () => StorageCleanupService.emergencyCleanup();
                break;
            default:
                cleanupFn = () => StorageCleanupService.cleanupStorage();
        }

        await cleanupFn();

        const usage = await StorageCleanupService.getDiskUsage();
        res.json({
            status: 'success',
            message: `清理完成，当前磁盘使用率: ${usage}%`,
            diskUsage: usage
        });
    } catch (err) {
        Logger.error('Gateway', '手动清理失败', err);
        res.status(500).json({
            status: 'error',
            message: '手动清理失败',
            details: err.message
        });
    }
});

module.exports = router;
