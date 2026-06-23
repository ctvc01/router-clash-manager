const express = require('express');
const Logger = require('../utils/logger');
const SpeedtestState = require('../services/speedtestState');
const GameAccService = require('../services/gameAccService');
const AiBoostService = require('../services/aiBoostService');
const ClashService = require('../services/clashService');

const router = express.Router();

// GET /api/speedtest/status
router.get('/status', (req, res) => {
    try {
        res.json(SpeedtestState.getStatus());
    } catch (err) {
        Logger.error('SpeedtestAPI', '获取状态失败', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/speedtest/lock { mode: 'ai'|'game', lock: true|false }
router.post('/lock', async (req, res) => {
    try {
        const { mode, lock } = req.body;
        if (!['ai', 'game'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be ai or game' });
        }

        if (lock) {
            let currentNode;
            try {
                const proxiesData = await ClashService.getProxies(5000);
                const groupName = mode === 'ai' ? '🤖 AI强化' : '🎮 游戏加速';
                const group = proxiesData.proxies[groupName];
                currentNode = group ? group.now : null;
            } catch (e) {
                currentNode = SpeedtestState.get(mode).lastNode;
            }

            if (currentNode) {
                SpeedtestState.setLockedNode(mode, currentNode);
                Logger.info('SpeedtestAPI', `${mode} 已锁定: ${currentNode}`);
            } else {
                return res.status(500).json({ error: '无法获取当前节点' });
            }
        } else {
            SpeedtestState.setLock(mode, false);
            Logger.info('SpeedtestAPI', `${mode} 已解锁`);
        }

        res.json(SpeedtestState.get(mode));
    } catch (err) {
        Logger.error('SpeedtestAPI', '切换锁定状态失败', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/speedtest/trigger { mode: 'ai'|'game' }
router.post('/trigger', async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['ai', 'game'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be ai or game' });
        }

        let result;
        if (mode === 'game') {
            result = await GameAccService.findBestAndLock(true);
        } else {
            result = await AiBoostService.findBestAndLock(true);
        }

        res.json({ success: true, result });
    } catch (err) {
        Logger.error('SpeedtestAPI', '手动触发测速失败', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
