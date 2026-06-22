const express = require('express');
const router = express.Router();
const BackupService = require('../services/backupService');
const Logger = require('../utils/logger');

router.get('/download', async (req, res) => {
    try {
        Logger.info('BackupAPI', '收到备份数据包下载请求');
        const data = await BackupService.getAggregatedBackup();
        res.json({
            success: true,
            data
        });
    } catch (err) {
        Logger.error('BackupAPI', '生成备份数据包失败', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

module.exports = router;
