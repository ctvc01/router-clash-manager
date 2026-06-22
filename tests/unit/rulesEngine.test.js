const RulesEngine = require('../../src/services/rulesEngine');
const { PROXY_GROUPS } = require('../../src/constants');

describe('RulesEngine.modifyConfigText 单元测试', () => {
    // 准备基础 Mock 的 Clash 配置文本
    const baseConfig = `
mixed-port: 7890
allow-lan: false
external-controller: '127.0.0.1:9090'
tun:
  enable: true
  stack: system
rules:
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
proxy-groups:
  - name: 🚀 节点选择
    type: select
    proxies:
      - 台湾自动
      - DIRECT
  - name: ⚡ 自动
    type: url-test
    proxies:
      - Node1
`;

    test('应该能够将 tun.enable 强制修改为 false 并保持其他 tun 配置项', () => {
        const finalConfig = RulesEngine.modifyConfigText(baseConfig, [], []);
        
        // 验证 tun.enable 变为了 false
        expect(finalConfig).toContain('enable: false');
        // 验证其他 tun 配置依然存在
        expect(finalConfig).toContain('stack: system');
        // 验证 allow-lan 被改写为 true
        expect(finalConfig).toContain('allow-lan: true');
        // 验证 external-controller 端口变为了配置指定的 (默认 9999)
        expect(finalConfig).toContain("external-controller: '0.0.0.0:9999'");
    });

    test('如果不存在 tun 配置，则不应该报错并且正常处理其他项', () => {
        const noTunConfig = `
mixed-port: 7890
allow-lan: false
rules:
  - GEOIP,CN,DIRECT
  - MATCH,DIRECT
proxy-groups:
  - name: 🚀 节点选择
    type: select
`;
        const finalConfig = RulesEngine.modifyConfigText(noTunConfig, [], []);
        expect(finalConfig).toContain('allow-lan: true');
    });

    test('如果 dns 和 sniffer 未开启，应该能够自动在 mixed-port 后注入', () => {
        const finalConfig = RulesEngine.modifyConfigText(baseConfig, [], []);
        expect(finalConfig).toContain('dns:');
        expect(finalConfig).toContain('sniffer:');
        expect(finalConfig).toContain('enhanced-mode: fake-ip');
        expect(finalConfig).toContain('parse-pure-ip-address: true');
    });

    test('当传入 AI 设备的 MAC 时，应该成功注入 AI 域名规则和 🤖 AI强化 策略组', () => {
        const finalConfig = RulesEngine.modifyConfigText(baseConfig, [], ['00:11:22:33:44:55']);
        
        // 验证 AI 规则注入
        expect(finalConfig).toContain('# === AI RULES START ===');
        expect(finalConfig).toContain('- DOMAIN-SUFFIX,openai.com,🤖 AI强化');
        expect(finalConfig).toContain('- DOMAIN-SUFFIX,chatgpt.com,🤖 AI强化');
        expect(finalConfig).toContain('# === AI RULES END ===');
        
        // 验证 🤖 AI强化 策略组注入
        expect(finalConfig).toContain(`name: '${PROXY_GROUPS.AI_BOOST}'`);
        // 自动选择节点中应包含 ⚡ 自动 (当前存在的 url-test/select 组)
        expect(finalConfig).toContain("'🚀 节点选择'");
        expect(finalConfig).toContain("'⚡ 自动'");
    });

    test('当传入 Game 设备的 MAC 时，应该成功注入 🎮 游戏加速 策略组', () => {
        const finalConfig = RulesEngine.modifyConfigText(baseConfig, ['aa:bb:cc:dd:ee:ff'], []);
        
        // 验证 🎮 游戏加速 策略组被注入
        expect(finalConfig).toContain(`name: '${PROXY_GROUPS.GAME_ACC}'`);
    });
});
