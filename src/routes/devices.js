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
        // 修改：使用 /proc/net/arp 代替 /tmp/dhcp.leases (Xiaomi 路由器兼容)
        const [arpOutput, hostnamesOutput, whitelistOutput, trafficOutput] = await Promise.all([
            SshService.runRemoteCommand('cat /proc/net/arp'),
            SshService.runRemoteCommand('cat /etc/hosts'),
            SshService.runRemoteCommand('cat /data/ShellCrash/configs/mac'),
            SshService.runRemoteCommand('ubus call trafficd hw').catch(() => '{}') // 降级处理
        ]);

        const gameMacs = GameAccService.readGameDevices().map(m => m.toLowerCase());
        const aiMacs = AiBoostService.readAiDevices().map(m => m.toLowerCase());
        const whitelist = whitelistOutput
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line.length > 0 && !gameMacs.includes(line) && !aiMacs.includes(line));

        // 解析 /etc/hosts 获取 hostname 映射
        const hostnameMap = {};
        hostnamesOutput.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
                hostnameMap[parts[0]] = parts[1];
            }
        });

        let trafficData = {};
        try {
            trafficData = JSON.parse(trafficOutput || '{}');
        } catch (e) {
            Logger.warn('Devices', '解析 trafficd 流量 JSON 失败，继续使用空流量数据', e.message);
        }

        const MAC_REGEX = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/;
        const IP_REGEX = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

        const lan_devices = [];
        const arpLines = arpOutput.split('\n');
        const seen = new Set(); // 去重

        for (const line of arpLines) {
            const parts = line.trim().split(/\s+/);
            // 格式: IP address | HW type | Flags | HW address | Mask | Device
            //      0          | 1       | 2     | 3          | 4    | 5
            if (parts.length >= 4) {
                const ip = parts[0].trim();
                const mac = parts[3].trim().toLowerCase();

                if (MAC_REGEX.test(mac) && IP_REGEX.test(ip) && !seen.has(mac)) {
                    seen.add(mac);
                    const macUpper = mac.toUpperCase();
                    const trafficInfo = trafficData[macUpper] || {};
                    const ipList = trafficInfo.ip_list || [];
                    const matchIpInfo = ipList.find(item => item.ip === ip) || ipList[0] || {};

                    // 尝试从 /etc/hosts 获取 hostname
                    let hostname = hostnameMap[ip] || '未知设备';

                    lan_devices.push({
                        mac,
                        ip,
                        hostname,
                        rx_rate: matchIpInfo.rx_rate || 0, // 下行流速
                        tx_rate: matchIpInfo.tx_rate || 0  // 上行流速
                    });
                }
            }
        }

        const custom = readCustom();
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
        customData[mac] = { name, category };
        
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
