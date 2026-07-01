const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const Logger = require('../utils/logger');

const STATE_FILE = path.join(config.paths.dataDir, 'speedtest_state.json');

const DEFAULT_STATE = {
    game: { lock: false, lockedNode: null, lastNode: null, lastDelay: -1, lastLoss: -1, lastSamples: '', perNodeResults: [], timestamp: 0 },
    ai:   { lock: false, lockedNode: null, lastNode: null, lastDelay: -1, lastSamples: '', timestamp: 0 },
    proxy: { lock: false, lockedNode: null, lastNode: null, lastDelay: -1, lastSamples: '', timestamp: 0 }
};

class SpeedtestState {
    static _state = null;

    static _load() {
        if (this._state) return this._state;
        try {
            if (fs.existsSync(STATE_FILE)) {
                this._state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                for (const mode of ['game', 'ai', 'proxy']) {
                    if (!this._state[mode]) this._state[mode] = DEFAULT_STATE[mode];
                }
            } else {
                this._state = JSON.parse(JSON.stringify(DEFAULT_STATE));
            }
        } catch (e) {
            Logger.warn('SpeedtestState', '加载状态失败，使用默认值', e);
            this._state = JSON.parse(JSON.stringify(DEFAULT_STATE));
        }
        return this._state;
    }

    static _save() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2), 'utf8');
        } catch (e) {
            Logger.warn('SpeedtestState', '保存状态失败', e);
        }
    }

    static get(mode) {
        return this._load()[mode];
    }

    static setLock(mode, lock) {
        const state = this._load();
        state[mode].lock = lock;
        if (!lock) state[mode].lockedNode = null;
        this._save();
        return state[mode];
    }

    static setLockedNode(mode, nodeName) {
        const state = this._load();
        state[mode].lockedNode = nodeName;
        state[mode].lock = true;
        this._save();
        return state[mode];
    }

    static updateResult(mode, result) {
        const state = this._load();
        if (result) {
            state[mode].lastNode = result.name;
            state[mode].lastDelay = result.delay;
            if (mode === 'game' && result.loss !== undefined) {
                state[mode].lastLoss = result.loss;
                state[mode].lastSamples = `${result.samples}/3`;
            } else {
                state[mode].lastSamples = '1/1';
            }
            state[mode].timestamp = Date.now();
        }
        this._save();
        return state[mode];
    }

    // 保存游戏模式完整 per-node 测速结果（用于前端下拉列表展示丢包率）
    static updateGamePerNodeResults(results) {
        const state = this._load();
        if (Array.isArray(results)) {
            state.game.perNodeResults = results.map(r => ({
                name: r.name,
                delay: r.rawDelay || r.delay,
                loss: r.loss,
                samples: r.samples,
                timestamp: r.timestamp || Date.now()
            }));
        }
        this._save();
    }

    static isLocked(mode) {
        return this._load()[mode].lock;
    }

    static getLockedNode(mode) {
        return this._load()[mode].lockedNode;
    }

    static getStatus() {
        const state = this._load();
        return {
            game: { ...state.game },
            ai: { ...state.ai },
            proxy: { ...state.proxy },
            perNodeResults: state.game.perNodeResults
        };
    }
}

module.exports = SpeedtestState;
