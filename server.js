// ==========================================
// Router Clash Manager - Root Bootstrap Entry
// ==========================================
// 自动加载 .env 文件，确保环境变量在应用启动前就绪
// 不依赖 dotenv 包，避免额外依赖
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const eqIndex = trimmed.indexOf('=');
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    });
    console.log('✅ [Bootstrap] 已从 .env 文件加载环境变量');
}

// 将启动过程导向 src/server.js 模块，保持单文件兼容性和 Docker 容器入口无缝兼容
require('./src/server');
