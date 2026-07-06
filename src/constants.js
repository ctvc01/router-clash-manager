// 统一的常量定义

const PROXY_GROUPS = {


    GAME_ACC: '🎮 游戏加速',
    AI_BOOST: '🤖 AI强化',
    NODE_SELECT: '🚀 节点选择',
    DIRECT: 'DIRECT',
    STREAMING: '🎬 流媒体加速',
    STREAMING_SPEEDTEST: '⚡ 流媒体自动测速'
};

const ROUTER_PATHS = {
    DHCP_LEASES: '/tmp/dhcp.leases',
    MAC_WHITELIST: '/data/ShellCrash/configs/mac',
    CLASH_CONFIG: '/data/ShellCrash/config.yaml',
    CLASH_CONFIG_BACKUP: '/tmp/config.yaml.bak',
    CRASH_CORE: '/tmp/ShellCrash/mihomo'
};

module.exports = {
    PROXY_GROUPS,
    ROUTER_PATHS,
    getBeijingTimeParts: () => {
        const f = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
        const parts = f.formatToParts(new Date());
        return {
            hour: parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10),
            minute: parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
        };
    }
};
