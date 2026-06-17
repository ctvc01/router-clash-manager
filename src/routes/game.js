const express = require('express');
const Logger = require('../utils/logger');
const Validators = require('../utils/validators');
const AccelerationService = require('../services/accelerationService');
const GameAccService = require('../services/gameAccService');

const router = express.Router();

// 1. 获取开启游戏加速的设备 MAC 列表
router.get('/list', (req, res) => {
    res.json(GameAccService.readGameDevices());
});

// 2. 开启设备游戏加速模式
router.post('/enable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        await AccelerationService.enableAcceleration(mac, 'game');
        res.json({ success: true });
    } catch (err) {
        Logger.error('GameAcc', '启用游戏加速接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    }
});

// 3. 关闭设备游戏加速模式
router.post('/disable', async (req, res) => {
    try {
        const mac = Validators.validateMAC(req.body.mac);
        await AccelerationService.disableAcceleration(mac, 'game');
        res.json({ success: true });
    } catch (err) {
        Logger.error('GameAcc', '禁用游戏加速接口异常', err);
        res.status(err.message && err.message.includes('格式') ? 400 : 500).json({
            success: false,
            message: err.message
        });
    }
});

module.exports = router;
