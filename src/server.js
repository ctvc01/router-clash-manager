const app = require('./app');
const { config, validateEnvironment } = require('./config');
const Logger = require('./utils/logger');
const ClashService = require('./services/clashService');
const ProxyHealthService = require('./services/proxyHealthService');
const GameAccService = require('./services/gameAccService');
const AiBoostService = require('./services/aiBoostService');
const RulesEngine = require('./services/rulesEngine');
const StorageCleanupService = require('./services/storageCleanupService');

// 1. 启动前强校验环境变量与核心凭证
validateEnvironment();

// 2. 初始化后台守护进程与定时监控任务
const activeGameDevices = GameAccService.readGameDevices();
const activeAiDevices = AiBoostService.readAiDevices();

// 如果有活跃的加速设备，启动时自动初始化规则注入
if (activeGameDevices.length > 0 || activeAiDevices.length > 0) {
    Logger.info('Daemon', `检测到当前有 ${activeGameDevices.length} 个游戏设备 + ${activeAiDevices.length} 个 AI 设备，正在初始化规则注入...`);
    RulesEngine.updateClashRules(activeGameDevices, activeAiDevices).catch(err => {
        Logger.warn('Daemon', '启动时规则注入失败（稍后会重试）', err);
    });
}

if (activeGameDevices.length > 0) {
    Logger.info('Daemon', `检测到当前有 ${activeGameDevices.length} 个加速设备，正在自动激活游戏加速守护进程...`);
    GameAccService.startGameAccMonitor();
}

// 启动北京时间每日凌晨 04:00 定时测速重测与锁定自愈任务
GameAccService.startDailyTaskMonitor();

// 初始化 AI 强化后台守护进程与定时监控任务
if (activeAiDevices.length > 0) {
    Logger.info('Daemon', `检测到当前有 ${activeAiDevices.length} 个 AI 强化设备，正在自动激活 AI 强化守护进程...`);
    AiBoostService.startAiBoostMonitor();
}

// 启动 AI 强化每日凌晨定时切换任务
AiBoostService.startDailyTaskMonitor();

// 启动代理端口及链路自愈全局健康度监测守护进程
ProxyHealthService.startProxyHealthMonitor();

// 启动存储空间定期清理任务（每日凌晨 02:00）
StorageCleanupService.startDailyCleanup();

// 异步验证路由器 API 连通性 (弱校验警示，不直接崩溃退出进程)
async function verifyConnectivity() {
    try {
        Logger.info('Server', '正在验证与路由器 Clash API 的连接状态...');
        const versionData = await ClashService.getVersion(4000);
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
