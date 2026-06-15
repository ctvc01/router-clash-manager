const path = require('path');

// 统一的环境变量与静态配置
const config = {
    // 路由器 SSH 登录凭证
    router: {
        ip: process.env.ROUTER_IP || '192.168.31.1',
        user: process.env.ROUTER_USER || 'root',
        password: process.env.ROUTER_PASSWORD || ''
    },
    // Clash 核心端口配置
    ports: {
        clash: parseInt(process.env.CLASH_PORT || '9999', 10),
        proxy: parseInt(process.env.PROXY_PORT || '7890', 10),
        dns: parseInt(process.env.DNS_PORT || '1053', 10)
    },
    // 后端服务监听端口
    port: parseInt(process.env.PORT || '3000', 10),
    
    // 数据文件存储路径
    paths: {
        custom: path.join(__dirname, '..', 'device_custom.json'),
        gameDevices: path.join(__dirname, '..', 'game_devices'),
        aiDevices: path.join(__dirname, '..', 'ai_devices'),
        sshExec: path.join(__dirname, '..', 'ssh_exec.exp')
    }
};

// 强校验必需的环境变量
function validateEnvironment() {
    const required = {
        ROUTER_IP: config.router.ip,
        ROUTER_USER: config.router.user,
        ROUTER_PASSWORD: config.router.password
    };
    
    const missing = Object.keys(required).filter(key => !required[key]);
    
    if (missing.length > 0) {
        console.error('❌ [Config] 缺少必需的环境变量或配置项:', missing.join(', '));
        console.error('   请在宿主机环境或 Docker Compose 的 environment 中注入这些变量。');
        process.exit(1);
    }
    
    console.log(`✅ [Config] 环境变量校验通过。连接目标: ${config.router.user}@${config.router.ip}`);
}

module.exports = {
    config,
    validateEnvironment
};
