const app = require('./app');
const { config, validateEnvironment } = require('./config');
const Logger = require('./utils/logger');
const PersistenceService = require('./services/persistenceService');
const ClashService = require('./services/clashService');
const ClashApiProxy = require('./utils/clashApiProxy');
const ProxyHealthService = require('./services/proxyHealthService');
const GameAccService = require('./services/gameAccService');
const AiBoostService = require('./services/aiBoostService');
const RulesEngine = require('./services/rulesEngine');
const StorageCleanupService = require('./services/storageCleanupService');
const ConfigVersionManager = require('./services/configVersionManager');
const ChangelogManager = require('./services/changelogManager');
const SystemValidator = require('./services/systemValidator');
const SshService = require('./services/sshService');
const { ROUTER_PATHS } = require('./constants');

// 1. 启动前强校验环境变量与核心凭证
validateEnvironment();

// 1.5 初始化数据持久化框架
PersistenceService.initializeAll();
PersistenceService.logIntegrityReport();

// 1.6 系统完整性检查（清理无效设备，验证规则注入）
(async () => {
    try {
        await SystemValidator.validateOnStartup();
    } catch (err) {
        Logger.error('Server', '系统完整性检查失败，但继续启动', err);
    }
})();

// 1.7 初始化配置版本管理和变更日志
ConfigVersionManager.initialize();
Logger.info('Server', '✅ 配置版本管理系统已初始化');

// 2. 初始化后台守护进程与定时监控任务
(async () => {
    const activeGameDevices = GameAccService.readGameDevices();
    const activeAiDevices = AiBoostService.readAiDevices();

    // 从容器本地文件重建路由器白名单（容器为权威数据源，防止路由器重启后丢失）
    const allAccDevices = [...new Set([...activeGameDevices, ...activeAiDevices])];
    Logger.info('Server', `本地加速设备: ${activeGameDevices.length}个游戏 + ${activeAiDevices.length}个AI = ${allAccDevices.length}个去重`);

    if (allAccDevices.length > 0) {
        try {
            // 写入路由器白名单（覆盖模式）
            const macContent = allAccDevices.join('\n') + '\n';
            await SshService.runRemoteCommand(`printf "${macContent}" > /data/ShellCrash/configs/mac`);
            Logger.info('Server', `已同步${allAccDevices.length}个设备到路由器白名单`);

            // 重建 iptables 规则
            await SshService.runRemoteCommand('sh /data/ShellCrash/setup_iptables.sh');
            Logger.info('Server', 'iptables TCP REDIRECT 规则已重建');

            await SshService.runRemoteCommand('sh /data/ShellCrash/setup_quic_block.sh');
            Logger.info('Server', 'QUIC (UDP 443) 阻断规则已添加');
        } catch (err) {
            Logger.warn('Server', '路由器白名单/iptables初始化失败（稍后会重试）', err);
        }
    }

    // 如果有活跃的加速设备，启动时自动初始化规则注入
    if (activeGameDevices.length > 0 || activeAiDevices.length > 0) {
        Logger.info('Daemon', `检测到当前有 ${activeGameDevices.length} 个游戏设备 + ${activeAiDevices.length} 个 AI 设备，正在初始化规则注入...`);
        await RulesEngine.updateClashRules(activeGameDevices, activeAiDevices).catch(err => {
            Logger.warn('Daemon', '启动时规则注入失败（稍后会重试）', err);
        });
    }

    // 启动时恢复游戏锁定状态（若 speedtest_state.json 中记录为 LOCKED）
    const SpeedtestState = require('./services/speedtestState');
    const gameState = SpeedtestState.get('game');
    if (gameState.lock && gameState.lockedNode) {
        Logger.info('Server', `🔄 恢复游戏锁定节点: ${gameState.lockedNode}`);
        const locked = await GameAccService.lockGameNode(gameState.lockedNode);
        if (!locked) {
            Logger.warn('Server', `⚠️ 锁定节点 ${gameState.lockedNode} 失败，3秒后重试...`);
            await new Promise(r => setTimeout(r, 3000));
            const retry = await GameAccService.lockGameNode(gameState.lockedNode);
            if (!retry) {
                Logger.warn('Server', `⚠️ 重试仍失败，保持 LOCKED 状态不变。节点可能需要手动重新锁定。`);
            }
        }
    }

    // 后续的守护进程启动代码...

    if (activeGameDevices.length > 0) {
        Logger.info('Daemon', `检测到当前有 ${activeGameDevices.length} 个加速设备，正在自动激活游戏加速守护进程...`);
        GameAccService.startGameAccMonitor();

        // 启动后 3 分钟内触发一次测速（LOCKED 时仅更新结果不切换）
        setTimeout(() => {
            if (SpeedtestState.isLocked('game')) {
                Logger.info('Server', '🔄 启动后首次游戏节点测速(LOCKED:仅更新)...');
                GameAccService.findFastestGameNode().catch(e =>
                    Logger.warn('Server', '启动测速失败', e.message));
            } else {
                Logger.info('Server', '🔄 启动后首次游戏节点测速+锁定...');
                GameAccService.findBestAndLock().catch(e =>
                    Logger.warn('Server', '启动测速失败', e.message));
            }
        }, 180000);
    }

    // 启动北京时间每日凌晨 04:00 定时测速重测与锁定自愈任务
    GameAccService.startDailyTaskMonitor();

    // 初始化 AI 强化后台守护进程与定时监控任务
    if (activeAiDevices.length > 0) {
        Logger.info('Daemon', `检测到当前有 ${activeAiDevices.length} 个 AI 强化设备，正在自动激活 AI 强化守护进程...`);
        AiBoostService.startAiBoostMonitor();

        // 启动后 3 分钟内触发一次测速并锁定最优节点
        setTimeout(() => {
            Logger.info('Server', '🔄 启动后首次 AI 节点测速+锁定...');
            AiBoostService.findBestAndLock().catch(e =>
                Logger.warn('Server', 'AI 启动测速失败', e.message));
        }, 210000);
    }

    // 启动 AI 强化每日凌晨定时切换任务
    AiBoostService.startDailyTaskMonitor();

    // 启动代理端口及链路自愈全局健康度监测守护进程
    ProxyHealthService.startProxyHealthMonitor();

    // 启动存储空间定期清理任务（每日凌晨 02:00）
    StorageCleanupService.startDailyCleanup();

    // 启动自动配置备份任务
    ConfigVersionManager.startAutoBackup(ROUTER_PATHS.CLASH_CONFIG);
    Logger.info('Server', '✅ 自动配置备份任务已启动');
})();

// 异步验证路由器 API 连通性 (弱校验警示，不直接崩溃退出进程)
async function verifyConnectivity() {
    try {
        Logger.info('Server', '正在验证与路由器 Clash API 的连接状态...');
        const versionData = await ClashApiProxy.getVersion();
        Logger.info('Server', `✅ 成功建立与 Clash 核心的连接！内核版本: ${versionData.version || '未知'}`);
    } catch (err) {
        Logger.warn('Server', `⚠️ 警告：目前无法连通路由器的 Clash API (可能由于路由器离线或未运行 Clash)。请检查网络和 ROUTER_IP。错误: ${err.message}`);
    }
}

// 3. 开启网络服务器监听
app.listen(config.port, () => {
    Logger.info('Server', `===================================================`);
    Logger.info('Server', `  Clash Meta Whitelist Manager Backend is running!`);
    Logger.info('Server', `  Listening on Port: ${config.port}`);
    Logger.info('Server', `  Environment Mode:  ${process.env.NODE_ENV || 'development'}`);
    Logger.info('Server', `===================================================`);
    
    // 异步执行连通性探测
    verifyConnectivity();
});
