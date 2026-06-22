// 统一的常量定义

const PROXY_GROUPS = {
    // 游戏加速
    GAME_ACC: '🎮 游戏加速',
    GAME_SPEEDTEST: '⚡ 游戏自动测速',

    // AI 强化
    AI_BOOST: '🤖 AI强化',
    AI_SPEEDTEST: '⚡ AI自动测速',

    // 通用
    NODE_SELECT: '🚀 节点选择',
    DIRECT: 'DIRECT'
};

const DEVICE_CATEGORIES = {
    PC: 'pc',
    PHONE: 'phone',
    TABLET: 'tablet',
    GAME: 'game',
    TV: 'tv',
    IOT: 'iot',
    OTHER: 'other'
};

const ROUTER_PATHS = {
    DHCP_LEASES: '/tmp/dhcp.leases',
    MAC_WHITELIST: '/data/ShellCrash/configs/mac',
    CLASH_CONFIG: '/data/ShellCrash/config.yaml',
    CLASH_CONFIG_BACKUP: '/tmp/config.yaml.bak',
    CRASH_CORE: '/tmp/ShellCrash/mihomo'
};

const SPEEDTEST_URLS = {
    NINTENDO: 'http://ctest.cdn.nintendo.net/',
    GOOGLE_AI: 'https://generativelanguage.googleapis.com/'
};

module.exports = {
    PROXY_GROUPS,
    DEVICE_CATEGORIES,
    ROUTER_PATHS,
    SPEEDTEST_URLS
};
