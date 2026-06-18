const express = require('express');
const os = require('os');
const { config } = require('../config');
const Logger = require('../utils/logger');
const SshService = require('../services/sshService');
const ClashService = require('../services/clashService');
const StorageCleanupService = require('../services/storageCleanupService');

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

// 辅助：获取 Clash 当前代理节点信息
async function getCurrentNodeInfo() {
    try {
        const proxiesData = await ClashService.getProxies();
        const proxies = proxiesData.proxies || {};
        
        let name = 'DIRECT';
        if (proxies['🚀 节点选择']) {
            name = proxies['🚀 节点选择'].now;
        } else if (proxies['GLOBAL']) {
            name = proxies['GLOBAL'].now;
        }
        
        // 递归查找物理节点
        const getRealPhysicalNode = (proxiesMap, nodeName, visited = new Set()) => {
            if (visited.has(nodeName)) {
                return { name: nodeName, delay: 0 };
            }
            visited.add(nodeName);
            const p = proxiesMap[nodeName];
            if (!p) return { name: nodeName, delay: 0 };
            if (p.now && typeof p.now === 'string') {
                return getRealPhysicalNode(proxiesMap, p.now, visited);
            }
            let delay = 0;
            if (p.history && p.history.length > 0) {
                const valid = p.history.filter(h => h.delay > 0);
                delay = valid.length > 0 ? valid[valid.length - 1].delay : (p.history[p.history.length - 1].delay || 0);
            }
            return { name: nodeName, delay };
        };
        
        return getRealPhysicalNode(proxies, name);
    } catch (e) {
        Logger.debug('Gateway', `查询当前节点异常: ${e.message}`);
        return { name: '未知', delay: 0 };
    }
}

// 1. 获取网关/代理运行状态
router.get('/status', async (req, res) => {
    try {
        // 1. 探测 Clash Core PID
        const pidOutput = await SshService.runRemoteCommand('pidof Clash || pidof CrashCore || pgrep -f "CrashCore|clash"');
        const pidMatch = pidOutput.match(/\b(\d+)\b/);
        const pid = pidMatch ? pidMatch[1] : '';
        const isRunning = pid.length > 0;

        // 2. 获取路由器物理总内存 MemTotal
        let totalMemory = '1024 MB';
        try {
            const memInfoOutput = await SshService.runRemoteCommand('cat /proc/meminfo | grep MemTotal');
            const match = memInfoOutput.match(/MemTotal:\s+(\d+)\s+kB/i);
            if (match) {
                totalMemory = `${Math.round(parseInt(match[1], 10) / 1024)} MB`;
            }
        } catch (memTotalErr) {
            Logger.debug('Gateway', '获取路由器总内存失败', memTotalErr);
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
                cpu: '0.0%',
                uptime: 0,
                localIp: getLocalIP(),
                port: config.port
            });
        }

        // 3. 获取运行中 Clash 占用内存 VmRSS
        let memory = '0 MB';
        try {
            const memOutput = await SshService.runRemoteCommand(`cat /proc/${pid}/status | grep VmRSS`);
            const match = memOutput.match(/VmRSS:\s+(\d+)\s+kB/i);
            if (match) {
                memory = `${Math.round(parseInt(match[1], 10) / 1024)} MB`;
            }
        } catch (memErr) {
            Logger.debug('Gateway', `获取 Clash 进程 ${pid} 内存失败`, memErr);
        }

        // 4. 获取 CPU 占用率
        let cpu = '0.0%';
        try {
            const cpuOutput = await SshService.runRemoteCommand(`top -b -n 1 | grep -v grep | grep -E "CrashCore|clash" | head -n 1`);
            const parts = cpuOutput.trim().split(/\s+/);
            const percentFields = parts.filter(p => p.includes('%'));
            if (percentFields.length > 0) {
                cpu = percentFields[percentFields.length - 1];
            } else if (parts.length >= 2) {
                const val = parts[parts.length - 2];
                if (/^\d+$/.test(val)) {
                    cpu = `${val}%`;
                }
            }
        } catch (cpuErr) {
            Logger.debug('Gateway', '获取 Clash CPU 占用失败', cpuErr);
        }

        // 5. 获取路由器运行时间 Uptime
        let uptime = 0;
        try {
            const uptimeOutput = await SshService.runRemoteCommand('cat /proc/uptime');
            const match = uptimeOutput.trim().match(/^(\d+(\.\d+)?)/);
            if (match) {
                uptime = Math.round(parseFloat(match[1]));
            }
        } catch (uptimeErr) {
            Logger.debug('Gateway', '获取运行时间失败', uptimeErr);
        }

        // 6. 异步获取 Clash API 版本与模式信息
        let version = '未知';
        let mode = '未知';
        let currentNode = '未知';
        let latency = 0;

        try {
            const vData = await ClashService.getVersion(1500);
            version = vData.version || '未知';
        } catch (e) {}

        try {
            const cData = await ClashService.getConfigs(1500);
            mode = cData.mode || '未知';
        } catch (e) {}

        try {
            const nodeInfo = await getCurrentNodeInfo();
            currentNode = nodeInfo.name;
            latency = nodeInfo.delay;
        } catch (e) {}

        res.json({
            status: 'success',
            running: true,
            currentNode,
            latency,
            version,
            mode,
            memory,
            totalMemory,
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
        const logOutput = await SshService.runRemoteCommand('tail -n 40 /tmp/ShellCrash/ShellCrash.log');
        res.json({
            status: 'success',
            log: logOutput
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
        const proxiesData = await ClashService.getProxies();
        const proxies = proxiesData.proxies || {};
        
        const getRealPhysicalNode = (proxiesMap, nodeName) => {
            const p = proxiesMap[nodeName];
            if (!p) return { name: nodeName, delay: 0 };
            // 如果节点是策略组，递归查找当前激活子节点
            if (p.now && typeof p.now === 'string' && proxiesMap[p.now]) {
                return getRealPhysicalNode(proxiesMap, p.now);
            }
            let delay = 0;
            if (p.history && p.history.length > 0) {
                const valid = p.history.filter(h => h.delay > 0);
                delay = valid.length > 0 ? valid[valid.length - 1].delay : (p.history[p.history.length - 1].delay || 0);
            }
            return { name: nodeName, delay };
        };

        const result = {
            proxy: {
                name: '🚀 节点选择',
                now: proxies['🚀 节点选择']?.now || 'DIRECT',
                realNode: getRealPhysicalNode(proxies, proxies['🚀 节点选择']?.now || 'DIRECT').name,
                delay: getRealPhysicalNode(proxies, proxies['🚀 节点选择']?.now || 'DIRECT').delay
            },
            game: {
                name: '🎮 游戏加速',
                now: proxies['🎮 游戏加速']?.now || 'DIRECT',
                realNode: getRealPhysicalNode(proxies, proxies['🎮 游戏加速']?.now || 'DIRECT').name,
                delay: getRealPhysicalNode(proxies, proxies['🎮 游戏加速']?.now || 'DIRECT').delay,
                all: []
            },
            ai: {
                name: '🤖 AI强化',
                now: proxies['🤖 AI强化']?.now || 'DIRECT',
                realNode: getRealPhysicalNode(proxies, proxies['🤖 AI强化']?.now || 'DIRECT').name,
                delay: getRealPhysicalNode(proxies, proxies['🤖 AI强化']?.now || 'DIRECT').delay
            }
        };

        // 整理游戏模式的所有可选物理节点 (过滤掉策略组名称和直连，包含名字和历史延迟)
        const filterOutGroups = ['⚡ 游戏自动测速', '🚀 节点选择', '👑 高级节点', 'DIRECT', 'GLOBAL'];
        if (proxies['🎮 游戏加速'] && proxies['🎮 游戏加速'].all) {
            result.game.all = proxies['🎮 游戏加速'].all
                .filter(name => !filterOutGroups.includes(name))
                .map(name => {
                    const p = proxies[name];
                    let delay = 0;
                    if (p && p.history && p.history.length > 0) {
                        const valid = p.history.filter(h => h.delay > 0);
                        delay = valid.length > 0 ? valid[valid.length - 1].delay : (p.history[p.history.length - 1].delay || 0);
                    }
                    return { name, delay };
                });
        }

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
            res.json({ status: 'success' });
        } else {
            res.status(500).json({ status: 'error', message: 'Clash API 切换节点失败' });
        }
    } catch (err) {
        Logger.error('Gateway', '切换节点路由发生异常', err);
        res.status(500).json({
            status: 'error',
            message: '切换节点失败',
            details: err.message
        });
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

module.exports = router;
