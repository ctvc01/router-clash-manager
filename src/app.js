const express = require('express');
const path = require('path');
const gatewayRouter = require('./routes/gateway');
const { router: devicesRouter } = require('./routes/devices');
const whitelistRouter = require('./routes/whitelist');
const gameRouter = require('./routes/game');
const Logger = require('./utils/logger');

const app = express();

// 1. 极轻量请求日志中间件
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        Logger.info('HTTP', `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// 2. 全局 JSON 解析
app.use(express.json());

// 3. 静态网页托管 (指向根目录下的 public 文件夹)
app.use(express.static(path.join(__dirname, '..', 'public')));

// 4. 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// 5. 路由分发挂载 (完美匹配原前端请求路径，无需改动前端)
app.use('/api', gatewayRouter);             // 提供 /api/status, /api/error-log
app.use('/api/devices', devicesRouter);     // 提供 /api/devices, /api/devices/custom
app.use('/api/whitelist', whitelistRouter); // 提供 /api/whitelist/add, /api/whitelist/remove
app.use('/api/game', gameRouter);           // 提供 /api/game/list, /api/game/enable, /api/game/disable

// 6. 全局异步错误捕获与兜底处理器 (防崩退)
app.use((err, req, res, next) => {
    Logger.error('Server', `未捕获的全局异常: ${req.method} ${req.path}`, err);
    res.status(err.status || 500).json({
        success: false,
        message: '服务器内部错误',
        details: process.env.DEBUG === 'true' ? err.message : undefined
    });
});

module.exports = app;
