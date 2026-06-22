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
        // 修改：优先使用 DHCP 租约文件，若不存在则用脚本生成，若都失败则用 ARP 表
        const [dhcpOutput, whitelistOutput, trafficOutput] = await Promise.all([
            (async () => {
                try {
                    // 方案：优先从 /tmp/dhcp.leases（标准位置）读取，失败则尝试 dnsmasq.leases 或旧 /data，最后降级至 ARP 表
                    return await SshService.runRemoteCommand('cat /tmp/dhcp.leases 2>/dev/null || cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /data/dhcp.leases 2>/dev/null || /tmp/generate_dhcp_leases.sh 2>/dev/null || cat /proc/net/arp');
                } catch (err) {
                    Logger.warn('Devices', '读取 DHCP 数据失败，降级使用 ARP', err.message);
                    return await SshService.runRemoteCommand('cat /proc/net/arp');
                }
            })(),
            SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac'),
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

        const lan_devices = [];
        const seen = new Set(); // 去重

        // 检测输入格式：DHCP 租约格式 或 ARP 表格式
        const lines = dhcpOutput.split('\n');
        const isDhcpFormat = lines.some(l => l.trim().match(/^\d+\s+[0-9a-f:]+\s+\d+\.\d+\.\d+\.\d+/));

        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            let ip, mac, hostname;
            let flags = '';
            let device = '';

            if (isDhcpFormat && parts.length >= 4) {
                // DHCP 租约格式: timestamp | mac | ip | hostname | *
                mac = parts[1].trim().toLowerCase();
                ip = parts[2].trim();
                hostname = parts[3].trim() === '*' ? '未知设备' : parts[3].trim();
            } else if (parts.length >= 6 && !parts[0].match(/^IP|^HW|^---/)) {
                // ARP 表格式: IP | HW type | Flags | MAC | Mask | Device
                // 或者:      0  | 1        | 2     | 3   | 4    | 5
                ip = parts[0].trim();
                flags = parts[2].trim();
                mac = parts[3].trim().toLowerCase();
                device = parts[5].trim();
                hostname = '未知设备';
            } else {
                continue; // 跳过头行或无效行
            }

            // 过滤条件加固：
            // 1. 符合 MAC 和 IP 正则
            // 2. MAC 不能为全零的未完成/无效状态（比如 198.18.0.2 Fake-IP 探测记录）
            // 3. ARP 格式下，物理网卡接口必须为 br-lan（局域网网桥），过滤 WAN 口侧设备（如 192.168.1.1 光猫）
            // 注意：不硬性过滤 flags === '0x0' 的真实 MAC 设备，以防止休眠设备（如 iPhone）被误判为离线清空
            if (MAC_REGEX.test(mac) && IP_REGEX.test(ip) && mac !== '00:00:00:00:00:00' && !seen.has(mac)) {
                if (!isDhcpFormat) {
                    if (device !== 'br-lan') {
                        continue;
                    }
                }
                seen.add(mac);
                const macUpper = mac.toUpperCase();
                const trafficInfo = trafficData[macUpper] || {};
                const ipList = trafficInfo.ip_list || [];
                const matchIpInfo = ipList.find(item => item.ip === ip) || ipList[0] || {};

                lan_devices.push({
                    mac,
                    ip,
                    hostname,
                    rx_rate: matchIpInfo.rx_rate || 0, // 下行流速
                    tx_rate: matchIpInfo.tx_rate || 0  // 上行流速
                });
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
        cache.set('deviceList', responseData, 15);
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
