// 数据输入校验与防御模块

const Validators = {
    // 验证 MAC 地址格式是否正确 (支持冒号和横线分隔)
    MAC_ADDRESS_PATTERN: /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/,
    
    // 设备备注名最大长度
    DEVICE_NAME_MAX_LENGTH: 64,
    
    // 前端支持的合法分类名称
    VALID_CATEGORIES: ['pc', 'phone', 'tablet', 'game', 'tv', 'iot', 'other'],

    // 强校验并规范化 MAC 地址
    validateMAC(mac) {
        if (!mac || typeof mac !== 'string') {
            throw new Error('MAC 地址不能为空且必须是字符串');
        }
        const trimmed = mac.trim();
        if (!this.MAC_ADDRESS_PATTERN.test(trimmed)) {
            throw new Error(`MAC 地址格式不合法: ${mac}`);
        }
        return trimmed.toLowerCase();
    },

    // 强校验设备自定义备注和类别
    validateDeviceCustom(name, category) {
        if (name === null || name === undefined) {
            throw new Error('设备名称参数缺失');
        }
        const trimmedName = String(name).trim();
        if (trimmedName.length === 0) {
            throw new Error('设备名称不能为空');
        }
        if (trimmedName.length > this.DEVICE_NAME_MAX_LENGTH) {
            throw new Error(`设备名称超长，最大允许 ${this.DEVICE_NAME_MAX_LENGTH} 个字符`);
        }

        if (!category || typeof category !== 'string') {
            throw new Error('设备分类参数缺失');
        }
        const trimmedCategory = category.trim();
        if (!this.VALID_CATEGORIES.includes(trimmedCategory)) {
            throw new Error(`不合法的设备分类: ${category}。合法分类为: ${this.VALID_CATEGORIES.join(', ')}`);
        }

        return {
            name: trimmedName,
            category: trimmedCategory
        };
    },

    // 防远程命令注入校验（白名单 + 黑名单双重检查）
    validateSSHCommand(command) {
        if (!command || typeof command !== 'string') {
            throw new Error('执行命令不能为空');
        }

        const trimmedCmd = command.trim();

        // 1. 黑名单：绝对禁用的危险操作
        const FORBIDDEN_PATTERNS = [
            /\brm\s+-rf\s+\//,        // rm -rf / 等根目录危险操作
            /\brm\s+(-[a-z]*\s+)*(\/data\s|\/data$|\/etc\s|\/etc$|\/root\s|\/root$|\/sys\s|\/sys$|\/usr\s|\/usr$|\/lib\s|\/lib$|\/bin\s|\/bin$|\/sbin\s|\/sbin$|\/boot\s|\/boot$)/,  // 只拦截删除整个关键目录本身
            /\bchown\b/,              // 所有权修改
            /\bdd\b/,                 // 磁盘操作
            /\bmkfs\b/,               // 格式化
            /\breboot\b/,             // 重启
            /\bshutdown\b/,           // 关闭
            /\|\s*sh\b/,              // 管道到 sh
            /\|\s*bash\b/,            // 管道到 bash
            /\|\s*nc\s+-l/,           // 监听的 nc（反向 shell）
            /\bwget\b/                // wget 下载
        ];

        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(trimmedCmd)) {
                throw new Error(`[Security] 拦截到危险操作`);
            }
        }

        const ALLOWED_COMMANDS = [
            'pidof', 'pgrep', 'cat', 'echo', 'grep', 'kill', 'sleep', 'curl',
            'netstat', 'cp', 'touch', 'base64', 'for', 'if', '(', 'true', 'false',
            'ubus', 'printf', 'top', '/etc/init.d/', 'rm', 'sed', 'mkdir', 'ln', 'iptables',
            'tail', 'head', 'awk', 'find', 'cut', 'df', 'tr', '[', 'test', 'sh', 'chmod', 'timeout',
            'pid='
        ];

        // 允许的绝对路径前缀（需要通过黑名单检查）
        const ALLOWED_PATH_PREFIXES = [
            '/tmp/ShellCrash/',      // ShellCrash 临时二进制
            '/data/ShellCrash/',     // ShellCrash 数据目录
            '/etc/init.d/'           // 系统服务管理脚本前缀
        ];

        const firstWord = trimmedCmd.split(/[\s|;&<>]/)[0].trim();

        // 先检查是否是绝对路径
        if (firstWord.startsWith('/')) {
            const isAllowedPath = ALLOWED_PATH_PREFIXES.some(prefix => firstWord.startsWith(prefix));
            if (isAllowedPath) {
                return trimmedCmd;  // 已通过黑名单检查，允许执行
            }
            throw new Error(`[Security] 命令路径 "${firstWord}" 不在白名单中`);
        }

        // 检查命令名是否在白名单中
        const isAllowed = ALLOWED_COMMANDS.some(cmd => {
            if (firstWord === cmd) return true;
            if (firstWord.startsWith(cmd + ' ')) return true;
            if (firstWord.startsWith(cmd)) return true;  // 允许路径前缀匹配
            return false;
        });

        if (!isAllowed) {
            throw new Error(`[Security] 命令 "${firstWord}" 不在白名单中`);
        }

        return trimmedCmd;
    }
};

module.exports = Validators;
