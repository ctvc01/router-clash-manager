const { getGameNodeTag, getGameNodeTestUrl, isGameRegionNode, GAME_TEST_URLS } = require('../../src/utils/gameNodeFilter');

describe('gameNodeFilter 场景标签与测试目标', () => {
    test('IPLC/游戏/限速等联机特征优先于直连/家宽标记为联机', () => {
        expect(getGameNodeTag('🇯🇵 IPLC-gRPC｜Japan [1.0][原生]')).toBe('联机');
        expect(getGameNodeTag('🇭🇰 IPLC-gRPC｜HongKong [1.0][家寬][Gemini]')).toBe('联机');
        expect(getGameNodeTag('🇯🇵 IPLC-gRPC｜JP Game&Media [1.0][家寬][限速]')).toBe('联机');
        expect(getGameNodeTag('🇼🇸 IPLC-gRPC｜Taiwan [1.0][家寬]')).toBe('联机');
    });

    test('家宽/Reality + gRPC 节点标记为下载', () => {
        expect(getGameNodeTag('🇯🇵 特殊｜日本-A [2.0][gRPC][家寬]')).toBe('下载');
        expect(getGameNodeTag('🇭🇰 直連｜香港-03 [1.0][gRPC][家寬]')).toBe('下载');
        expect(getGameNodeTag('🇼🇸 直連｜台灣-03 [1.0][家寬][gRPC]')).toBe('下载');
    });

    test('直连+gRPC 但无家宽/Reality 时保守标记为联机', () => {
        expect(getGameNodeTag('🇯🇵 直連｜日本-04 [2.0][gRPC]')).toBe('联机');
        expect(getGameNodeTag('🇸🇬 直連｜新加坡-02 [1.0][原生][gRPC]')).toBe('联机');
    });

    test('无线路特征的纯 gRPC 节点默认为联机', () => {
        expect(getGameNodeTag('🇯🇵 特殊｜日本-C [1.0][gRPC]')).toBe('联机');
    });

    test('纯 Reality/家宽节点标记为下载', () => {
        expect(getGameNodeTag('🇯🇵 直連｜日本-01 [1.0][Reality][電信优化]')).toBe('下载');
        expect(getGameNodeTag('🇼🇸 直連｜台灣-04 [1.0][家寬][Reality]')).toBe('下载');
    });

    test('下载/联机使用真实 Nintendo 场景目标地址', () => {
        expect(getGameNodeTestUrl('🇯🇵 直連｜日本-01 [1.0][Reality]')).toContain('atum.p01.lp1.d4c.srv.nintendo.net');
        expect(getGameNodeTestUrl('🇯🇵 IPLC-gRPC｜Japan [1.0]')).toContain('conntest.nintendowifi.net');
        expect(GAME_TEST_URLS.downloadSpeed).toContain('cloudflare.com');
    });

    test('香港节点仍按联机/下载场景选择测试目标', () => {
        expect(getGameNodeTestUrl('🇭🇰 直連｜香港-11 [1.0][家寬][試用][Reality]')).toContain('atum.p01.lp1.d4c.srv.nintendo.net');
        expect(getGameNodeTestUrl('🇭🇰 IPLC-gRPC｜香港-01 [1.0]')).toContain('conntest.nintendowifi.net');
    });

    test('五地区筛选只保留香港/台湾/日本/韩国/新加坡', () => {
        expect(isGameRegionNode('🇭🇰 直連｜香港-01')).toBe(true);
        expect(isGameRegionNode('🇼🇸 直連｜台灣-01')).toBe(true);
        expect(isGameRegionNode('🇯🇵 直連｜日本-01')).toBe(true);
        expect(isGameRegionNode('🇰🇷 IPLC-gRPC｜Korea')).toBe(true);
        expect(isGameRegionNode('🇸🇬 直連｜新加坡-01')).toBe(true);
        expect(isGameRegionNode('🇺🇸 直連｜美國-01')).toBe(false);
    });
});
