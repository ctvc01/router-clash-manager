const express = require('express');
const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const cache = require('../utils/cache');
const Validators = require('../utils/validators');
const SshService = require('../services/sshService');
const GameAccService = require('../services/gameAccService');
const AiBoostService = require('../services/aiBoostService');
const PersistenceService = require('../services/persistenceService');

const router = express.Router();

// 辅助：读取本地设备别名自定义存储（使用持久化服务）
function readCustom() {
    return PersistenceService.readJSON(config.paths.custom, {});
}

// 辅助：写入本地设备别名自定义存储（使用持久化服务）
function writeCustom(customData) {
    return PersistenceService.writeJSON(config.paths.custom, customData);
}

// 1. 获取局域网设备及代理/流量数据 (带 15 秒缓存优化)
router.get('/', async (req, res) => {
    try {
        // 尝试从内存缓存中获取设备列表
        let cachedData = cache.get('deviceList');
        if (cachedData) {
            Logger.debug('Devices', '命中设备列表缓存，跳过远程 SSH 查询。');
            return res.json(cachedData);
        }

        // 无缓存，从路由器拉取原始数据
        // 同时从 DHCP 租约与 ARP 路由表中合并拉取完整设备列表，确保静态 IP/智能家居设备不遗漏
        const [dhcpOutput, arpOutput, whitelistOutput, trafficOutput] = await Promise.all([
            SshService.runRemoteCommand('cat /tmp/dhcp.leases 2>/dev/null || cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /data/dhcp.leases 2>/dev/null').catch(() => ''),
            SshService.runRemoteCommand('cat /proc/net/arp 2>/dev/null').catch(() => ''),
            SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac').catch(() => ''),
            SshService.runRemoteCommand('ubus call trafficd hw').catch(() => '{}')
        ]);

        const gameMacs = GameAccService.readGameDevices().map(m => m.toLowerCase());
        const aiMacs = AiBoostService.readAiDevices().map(m => m.toLowerCase());
        const whitelist = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0 && !gameMacs.includes(line) && !aiMacs.includes(line));

        let trafficData = {};
        try {
            trafficData = JSON.parse(trafficOutput || '{}');
        } catch (e) {
            Logger.warn('Devices', '解析 trafficd 流量 JSON 失败，继续使用空流量数据', e.message);
        }

        const MAC_REGEX = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/;
        const IP_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

        // 常见硬件厂商 OUI 前缀字典（用于自动识别智能家居/IoT设备的品牌名称）
        const ouiMap = {
            'cc:08:fa': 'Apple 苹果设备',
            '3e:1c:95': 'Apple iPhone',
            'c4:12:34': 'Apple iPad',
            'f6:42:d7': 'Apple Watch',
            'b8:88:80': 'Apple 苹果设备',
            'a4:39:b3': 'Xiaomi 小米路由器/设备',
            '48:26:4c': 'Xiaomi 小米路由器',
            '68:ab:bc': 'Xiaomi 小米设备',
            'b8:4d:43': 'Xiaomi 小米智能设备',
            '12:77:38': 'Redmi 红米手机',
            'e4:fe:43': 'Espressif/米家智能硬件',
            '24:0a:c4': 'Espressif/米家智能硬件',
            '30:ae:a4': 'Espressif/米家智能硬件',
            '84:f3:eb': 'Espressif/米家智能硬件',
            '60:01:94': 'Espressif/米家智能硬件',
            '4c:c6:4c': 'Tuya 涂鸦智能设备',
            'd4:f0:ea': 'Tuya 涂鸦智能设备',
            'cc:4d:75': 'BroadLink 智能插座',
            'ac:cf:23': 'Hanfeng 汉枫智能模块',
            '1c:1b:0d': 'NAS 存储服务器',
            '10:7c:61': 'Espressif 物联网设备',
            '8c:d0:b2': '智能家居设备',
            'ac:8c:46': '智能家居设备',
            'c0:84:ff': '智能家居设备',
            'c4:93:bb': '智能家居设备',
            '2a:11:bd': '智能家居设备',
            '78:df:72': '智能家居设备',
            '80:3e:4f': '智能家居设备',
            '1c:ea:ac': '智能家居设备',
            'ee:c3:d0': '智能家居设备',
            '40:44:f7': 'Switch / 游戏设备',
            '40:1a:58': '智能终端设备'
        };

        const getFriendlyHostname = (mac, ip, rawHostname) => {
            if (rawHostname && rawHostname !== '未知设备' && rawHostname !== '*') {
                return rawHostname;
            }
            const prefix = mac.toLowerCase().slice(0, 8);
            const vendor = ouiMap[prefix];
            const lastOctet = ip.split('.').pop();
            if (vendor) {
                return `${vendor} (.${lastOctet})`;
            }
            return `未知设备 (.${lastOctet})`;
        };

        const dhcpMap = {};
        if (dhcpOutput) {
            for (const line of dhcpOutput.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 4 && parts[1] && parts[1].includes(':')) {
                    const mac = parts[1].trim().toLowerCase();
                    const ip = parts[2].trim();
                    const hostname = parts[3].trim() === '*' ? '' : parts[3].trim();
                    if (MAC_REGEX.test(mac) && IP_REGEX.test(ip)) {
                        dhcpMap[mac] = { ip, hostname };
                    }
                }
            }
        }

        const lan_devices = [];
        const seen = new Set(); // MAC 去重

        // 1. 注入 DHCP 租约中登记的设备
        for (const [mac, info] of Object.entries(dhcpMap)) {
            if (mac !== '00:00:00:00:00:00' && !seen.has(mac)) {
                seen.add(mac);
                const macUpper = mac.toUpperCase();
                const trafficInfo = trafficData[macUpper] || {};
                const ipList = trafficInfo.ip_list || [];
                const matchIpInfo = ipList.find(item => item.ip === info.ip) || ipList[0] || {};
                const trafficHostname = trafficInfo.hostname && trafficInfo.hostname !== '*' ? trafficInfo.hostname : null;
                const rawName = trafficHostname || info.hostname;

                lan_devices.push({
                    mac,
                    ip: info.ip,
                    hostname: getFriendlyHostname(mac, info.ip, rawName),
                    rx_rate: matchIpInfo.rx_rate || 0,
                    tx_rate: matchIpInfo.tx_rate || 0
                });
            }
        }

        // 2. 补充 ARP 路由表中位于 br-lan 且不在 DHCP 租约中的静态 IP/活跃物理设备
        if (arpOutput) {
            for (const line of arpOutput.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 6 && !parts[0].match(/^IP|^HW|^---/)) {
                    const ip = parts[0].trim();
                    const mac = parts[3].trim().toLowerCase();
                    const device = parts[5].trim();
                    if (device === 'br-lan' && MAC_REGEX.test(mac) && IP_REGEX.test(ip) && mac !== '00:00:00:00:00:00' && !seen.has(mac)) {
                        seen.add(mac);
                        const macUpper = mac.toUpperCase();
                        const trafficInfo = trafficData[macUpper] || {};
                        const ipList = trafficInfo.ip_list || [];
                        const matchIpInfo = ipList.find(item => item.ip === ip) || ipList[0] || {};
                        const trafficHostname = trafficInfo.hostname && trafficInfo.hostname !== '*' ? trafficInfo.hostname : null;

                        lan_devices.push({
                            mac,
                            ip,
                            hostname: getFriendlyHostname(mac, ip, trafficHostname),
                            rx_rate: matchIpInfo.rx_rate || 0,
                            tx_rate: matchIpInfo.tx_rate || 0
                        });
                    }
                }
            }
        }

        const custom = readCustom();
        let needWriteBack = false;
        for (const [mac, item] of Object.entries(custom)) {
            if (item && !item.name && item.category === 'other') {
                delete custom[mac];
                needWriteBack = true;
            }
        }
        if (needWriteBack) {
            writeCustom(custom);
        }
        const responseData = {
            whitelist,
            lan_devices,
            custom,
            gameList: gameMacs,
            aiList: aiMacs
        };

        // 将获取的数据缓存 15 秒
        cache.set('deviceList', responseData, 60);
        Logger.debug('Devices', `成功获取 ${lan_devices.length} 个局域网设备`);
        res.json(responseData);
    } catch (err) {
        Logger.error('Devices', '获取局域网设备数据发生异常', err);
        // 异常降级兜底处理，使用空数据和本地缓存以保护稳定性
        res.json({
            whitelist: [],
            lan_devices: [],
            custom: readCustom(),
            gameList: [],
            aiList: []
        });
    }
});

// 2. 提交保存设备自定义别名和分类类别 (带 Validators 参数安全拦截)
router.post('/custom', (req, res) => {
    try {
        // 参数校验拦截
        const mac = Validators.validateMAC(req.body.mac);
        const { name, category } = Validators.validateDeviceCustom(req.body.name, req.body.category);
        
        const customData = readCustom();
        if (!name && category === 'other') {
            delete customData[mac];
        } else {
            customData[mac] = { name, category };
        }
        
        if (writeCustom(customData)) {
            // 主动失效设备列表缓存以强制即时刷新
            cache.clear('deviceList');
            res.json({ success: true });
        } else {
            res.status(500).json({ success: false, message: '保存设备自定义属性失败' });
        }
    } catch (err) {
        Logger.warn('Devices', `提交自定义设备属性不合法被拒绝: ${err.message}`);
        res.status(400).json({ success: false, message: err.message });
    }
});

module.exports = {
    router,
    readCustom,
    writeCustom
};
