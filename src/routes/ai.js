const express = require('express');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');
const AccelerationService = require('../services/accelerationService');
const AiBoostService = require('../services/aiBoostService');

const router = express.Router();

// 1. 获取开启 AI 强化的设备 MAC 列表
router.get('/list', (req, res) => {
    res.json(AiBoostService.readAiDevices());
});

// 2. 开启设备 AI 强化模式
router.post('/enable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        await AccelerationService.enableAcceleration(mac, 'ai');
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '启用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    }
});

// 3. 关闭设备 AI 强化模式
router.post('/disable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        await AccelerationService.disableAcceleration(mac, 'ai');
        res.json({ success: true });
    } catch (err) {
        Logger.error('AiBoost', '禁用 AI 强化接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    }
});

module.exports = router;
