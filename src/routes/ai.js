const express = require('express');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');
const AccelerationService = require('../services/accelerationService');
const AiBoostService = require('../services/aiBoostService');

const router = express.Router();

// 防止重复请求：同一 MAC 的 enable/disable 操作只允许一个在执行
const inFlight = new Map();

// 1. 获取开启 AI 强化的设备 MAC 列表
router.get('/list', (req, res) => {
    res.json(AiBoostService.readAiDevices());
});

// 2. 开启设备 AI 强化模式
router.post('/enable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        const key = `enable:${mac}`;
        const existing = inFlight.get(key);
        if (existing) {
            Logger.info('AiBoost', `设备 ${mac} 的 AI 强化请求正在进行中，复用已有执行`);
            return res.json(await existing);
        }
        const promise = AccelerationService.enableAcceleration(mac, 'ai');
        inFlight.set(key, promise);
        const result = await promise;
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '启用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    } finally {
        inFlight.delete(`enable:${mac}`);
    }
});

// 3. 关闭设备 AI 强化模式
router.post('/disable', async (req, res) => {
    let mac = '';
    try {
        mac = Validators.validateMAC(req.body.mac);
        const key = `disable:${mac}`;
        const existing = inFlight.get(key);
        if (existing) {
            Logger.info('AiBoost', `设备 ${mac} 的 AI 强化关闭请求正在进行中，复用已有执行`);
            return res.json(await existing);
        }
        const promise = AccelerationService.disableAcceleration(mac, 'ai');
        inFlight.set(key, promise);
        const result = await promise;
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '禁用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    } finally {
        inFlight.delete(`disable:${mac}`);
    }
});

module.exports = router;
