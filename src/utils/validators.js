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

    // 防远程命令注入校验
    validateSSHCommand(command) {
        if (!command || typeof command !== 'string') {
            throw new Error('执行命令不能为空');
        }
        // 1. 敏感命令指纹拦截
        const dangerousPatterns = [
            'rm -rf', '>&', '<<', 'nc -l', '/dev/zero', 'mkfifo'
        ];
        for (const pattern of dangerousPatterns) {
            if (command.includes(pattern)) {
                throw new Error(`[Security] 拦截到可能的恶意命令注入指纹: ${pattern}`);
            }
        }
        // 2. 精准单词边界检测拦截，防止运行未授权的可执行程序 (避免误杀 shellcrash 等 sh 结尾的名词)
        const dangerousWords = /\b(sh|bash|wget|nc)\b/;
        const match = command.match(dangerousWords);
        if (match) {
            throw new Error(`[Security] 拦截到未授权的程序执行: ${match[1]}`);
        }
        return command;
    }
};

module.exports = Validators;
