const fs = require('fs');
const { config } = require('../config');
const Logger = require('../utils/logger');
const ClashService = require('./clashService');
const SshService = require('./sshService');
const PersistenceService = require('./persistenceService');
const SpeedtestState = require('./speedtestState');
const { getBeijingTimeParts, PROXY_GROUPS } = require('../constants');
const { isGameRegionNode, getGameNodeTag, getGameNodeTestUrl, getGameNodeTestUrls, GAME_TEST_URLS } = require('../utils/gameNodeFilter');

let gameAccCheckTimer = null;
let dailyCheckTimer = null;
let dailyCheckDone = false;
let gameAccStartTimeout = null;
let silentPeriodicalTimer = null;
let silentRunning = false; // 静默测速重入锁
let silentStartTimeout = null;

class GameAccService {
    static readGameDevices() {
        const data = PersistenceService.readText(config.paths.gameDevices, '');
        return data.split('\n').map(line => line.trim().toLowerCase()).filter(line => line.length > 0);
    }
    static writeGameDevices(devices) {
        return PersistenceService.writeText(config.paths.gameDevices, devices.join('\n') + '\n');
    }

    // 下载场景带宽实测：手动测速时执行；自动心跳默认不执行，避免频繁大流量下载。
    // 若需要常开，可额外设置 GAME_DOWNLOAD_SPEED_TEST=true。
    static async measureDownloadBandwidth(nodeName, includeDownloadBandwidth = false) {
        if (!includeDownloadBandwidth && process.env.GAME_DOWNLOAD_SPEED_TEST !== 'true') return null;
        if (!nodeName) return null;
        const axios = require('axios');
        // 先切到被测节点，确保带宽测试走该节点（否则会按规则链 MATCH 走其他组）
        await ClashService.selectProxyNode(PROXY_GROUPS.GAME_DOWNLOAD, nodeName);
        const controller = new AbortController();
        const hardTimeout = setTimeout(() => controller.abort(), 8000);
        try {
            const started = Date.now();
            // 多连接并行（4 x 2MB）：更接近 Switch 多线程下载的真实并发带宽，8s 硬超时保护
            const CONCURRENCY = 4;
            const bytesPerConn = 2 * 1024 * 1024;
            const baseUrl = GAME_TEST_URLS.downloadSpeed.split('?')[0];
            const urls = Array.from({ length: CONCURRENCY }, (_, i) => `${baseUrl}?bytes=${bytesPerConn}&conn=${i}`);
            const results = await Promise.all(urls.map(url => axios({
                method: 'GET',
                url,
                signal: controller.signal,
                proxy: {
                    host: config.router.ip,
                    port: config.ports.proxy || 7890
                },
                responseType: 'arraybuffer',
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 300
            }).then(res => res.data.length).catch(() => 0)));
            const elapsedSec = (Date.now() - started) / 1000;
            const totalBytes = results.reduce((a, b) => a + b, 0);
            const mbps = (totalBytes / (1024 * 1024)) * 8 / elapsedSec;
            Logger.info('GameAcc', `下载带宽实测 ${nodeName}: ${totalBytes} bytes/${CONCURRENCY}并发 in ${elapsedSec.toFixed(2)}s ≈ ${mbps.toFixed(2)} Mbps`);
            return Number(mbps.toFixed(2));
        } catch (err) {
            Logger.debug('GameAcc', `下载带宽实测失败 ${nodeName}: ${err.message}`);
            return null;
        } finally {
            clearTimeout(hardTimeout);
        }
    }

    // 真实 Nintendo CDN 多目标并发探测：验证节点到真实下载 CDN 的并发连接与响应能力。
    // CDN 对非鉴权请求返回 403，仍可测连通与 RTT；作为下载排序的次级信号（真实带宽优先）。
    static async measureNintendoCdnConcurrency(nodeName) {
        if (!nodeName) return null;
        const axios = require('axios');
        // 先切到被测节点，确保探测走该节点（否则会按规则链 MATCH 走其他组）
        await ClashService.selectProxyNode(PROXY_GROUPS.GAME_DOWNLOAD, nodeName);
        const controller = new AbortController();
        const hardTimeout = setTimeout(() => controller.abort(), 6000);
        try {
            const started = Date.now();
            const results = await Promise.all(GAME_TEST_URLS.download.map(url => axios({
                method: 'GET',
                url,
                signal: controller.signal,
                proxy: {
                    host: config.router.ip,
                    port: config.ports.proxy || 7890
                },
                responseType: 'arraybuffer',
                maxRedirects: 3,
                validateStatus: () => true,
                timeout: 4000
            }).then(res => ({ ok: true, code: res.status })).catch(() => ({ ok: false }))));
            const okCount = results.filter(r => r.ok).length;
            const elapsedSec = (Date.now() - started) / 1000;
            Logger.info('GameAcc', `真实CDN并发探测 ${nodeName}: ${okCount}/${results.length} 可达 in ${elapsedSec.toFixed(2)}s`);
            return { okCount, total: results.length, elapsedSec: Number(elapsedSec.toFixed(2)) };
        } catch (err) {
            Logger.debug('GameAcc', `真实CDN并发探测失败 ${nodeName}: ${err.message}`);
            return null;
        } finally {
            clearTimeout(hardTimeout);
        }
    }

    // 优先丢包率 → 加权延迟（Japan/Taiwan/Korea region bias + gRPC penalty）
    static async findFastestGameNode(includeDownloadBandwidth = false) {
        try {
            ClashService.setFullSpeedtestFlag(true);
            const realStats = require('./realTrafficMonitor').getStats();
            Logger.info('GameAcc', '🔍 3-采样 Nintendo 场景测速（联机/下载不同目标） 日/新/韩/台加权 gRPC惩罚...');
            const proxiesData = await ClashService.getProxies(6000);
            const group = proxiesData.proxies['🎮 游戏加速'];
            if (!group || !group.all || group.all.length === 0) {
                Logger.warn('GameAcc', '未找到 🎮 游戏加速 组，无法自动寻优');
                return null;
            }
            // 过滤掉策略组名称（节点选择、DIRECT 等），仅保留物理节点
            const physicalNodes = group.all.filter(name => {
                const lower = name.toLowerCase();
                return !['direct', 'global', 'rejection'].includes(lower) &&
                      !lower.includes('节点选择') &&
                      !lower.includes('选择节点') &&
                      !lower.includes('自动测速') &&
                      isGameRegionNode(name);
            });
            if (physicalNodes.length === 0) {
                Logger.warn('GameAcc', '🎮 游戏加速 组中无可用物理节点，跳过测速');
                return null;
            }
            const NODE_SAMPLES = 2;
            const TIMEOUT_MS = 3000;
           
           const results = [];
           for (const nodeName of physicalNodes) {
               const scenarioTag = getGameNodeTag(nodeName);
               // 下载场景多 CDN 目标各测 1 次（取最快目标），联机场景单目标测 NODE_SAMPLES 次
               const testUrls = getGameNodeTestUrls(nodeName);
               const perUrlSamples = testUrls.length === 1 ? NODE_SAMPLES : 1;
               const totalSamples = testUrls.length * perUrlSamples;
               let successCount = 0, totalDelay = 0, sampleIdx = 0;
               for (const testUrl of testUrls) {
                   for (let i = 0; i < perUrlSamples; i++) {
                       sampleIdx++;
                       const delay = await ClashService.testNodeDelay(nodeName, TIMEOUT_MS, testUrl);
                       if (delay > 0) { successCount++; totalDelay += delay; }
                       if (sampleIdx < totalSamples) await new Promise(r => setTimeout(r, 200));
                   }
               }
                const lossRate = (totalSamples - successCount) / totalSamples;
                const avgDelay = successCount > 0 ? Math.round(totalDelay / successCount) : 99999;
               const lowerName = nodeName.toLowerCase();
               const isJapan = lowerName.includes('japan') || lowerName.includes('日本') || lowerName.includes('jp');
               const isTaiwan = lowerName.includes('taiwan') || lowerName.includes('台灣') || lowerName.includes('台湾') || lowerName.includes('tw');
               const isKorea = lowerName.includes('korea') || lowerName.includes('韩国') || lowerName.includes('kr');
               const isSingapore = lowerName.includes('singapore') || lowerName.includes('新加坡') || lowerName.includes('sg');
               const isGRPC = lowerName.includes('grpc');
               const isReality = lowerName.includes('reality');
               const isDirectLine = lowerName.includes('直連') || lowerName.includes('直连') ||
                                    lowerName.includes('家寬') || lowerName.includes('家宽');
               let weight = 1.0;
               if (isJapan) weight = 0.75; else if (isTaiwan) weight = 0.85; else if (isSingapore) weight = 0.88; else if (isKorea) weight = 0.90;
               // gRPC 对游戏下载/联机普遍不如 Reality/直连稳定，统一惩罚；Reality/直连给优先权重
               if (isGRPC) weight *= 1.15;
               if (isReality || isDirectLine) weight *= 0.9;
                const weightedDelay = successCount > 0 ? Math.round(avgDelay * weight) : 99999;
               results.push({ 
                  name: nodeName, 
                  delay: weightedDelay, 
                   rawDelay: avgDelay, 
                  loss: lossRate, 
                  samples: successCount, 
                  downloadSpeed: await this.measureDownloadBandwidth(nodeName, includeDownloadBandwidth),
                  cdnConcurrency: (includeDownloadBandwidth && scenarioTag === '下载') ? await this.measureNintendoCdnConcurrency(nodeName) : null,
                  realDownloadMbps: realStats[nodeName] ? realStats[nodeName].realDownloadMbps : null,
                  region: isJapan ? 'JP' : (isTaiwan ? 'TW' : (isSingapore ? 'SG' : (isKorea ? 'KR' : 'OTHER'))), 
                  tag: scenarioTag,
                  testUrls,
                  isGRPC,
                  isReality,
                  isDirectLine,
                  timestamp: Date.now()
                });
                
                // 增量更新 per-node 结果，供前端实时展示丢包率
                SpeedtestState.updateGamePerNodeResults([...results]);
                
                // 【硬件防波段】：每次节点测速后强制防抖间隔，防止路由器 CPU 瞬间冲高
                await new Promise(r => setTimeout(r, 500));
            }
           if (results.length === 0) { Logger.warn('GameAcc', '无可用游戏节点'); return null; }
            // 分别选出联机最优（丢包率→延迟）和下载最优（带宽→丢包率→延迟）
            // 下载候选扩大到所有有带宽数据的节点（IPLC 专线也可能高带宽，用数据说话）
            const onlineResults = results.filter(r => r.tag !== '下载');
            const downloadResults = results.filter(r =>
                (typeof r.downloadSpeed === 'number' && r.downloadSpeed > 0) ||
                (typeof r.realDownloadMbps === 'number' && r.realDownloadMbps > 0)
            );
            onlineResults.sort((a, b) => { if (a.loss !== b.loss) return a.loss - b.loss; return a.delay - b.delay; });
            downloadResults.sort((a, b) => {
                // 真实流量校准优先：Switch 实际下载链路带宽比 Cloudflare 合成测速更能反映真实体验
                const sa = a.realDownloadMbps > 0 ? a.realDownloadMbps : (typeof a.downloadSpeed === 'number' && a.downloadSpeed > 0 ? a.downloadSpeed : 0);
                const sb = b.realDownloadMbps > 0 ? b.realDownloadMbps : (typeof b.downloadSpeed === 'number' && b.downloadSpeed > 0 ? b.downloadSpeed : 0);
                if (sb !== sa) return sb - sa;
                // 真实 CDN 多目标并发可达率：带宽相近时优先能同时连上更多真实下载 CDN 的节点
                const ca = a.cdnConcurrency && a.cdnConcurrency.total ? a.cdnConcurrency.okCount / a.cdnConcurrency.total : 0;
                const cb = b.cdnConcurrency && b.cdnConcurrency.total ? b.cdnConcurrency.okCount / b.cdnConcurrency.total : 0;
                if (cb !== ca) return cb - ca;
                if (a.loss !== b.loss) return a.loss - b.loss;
                return a.delay - b.delay;
            });
            const bestOnline = onlineResults[0] || results[0];
            const bestDownload = downloadResults[0] || null;
            const lossPct = (bestOnline.loss * 100).toFixed(0);
            Logger.info('GameAcc', `✅ 联机最优: ${bestOnline.name} raw=${bestOnline.rawDelay}ms loss=${lossPct}% ${bestOnline.region}${bestOnline.isGRPC?' gRPC':''}`);
            if (bestDownload) {
                const realSpeed = bestDownload.realDownloadMbps ? `${bestDownload.realDownloadMbps} Mbps(真实)` : null;
                const dlSpeed = realSpeed || (bestDownload.downloadSpeed ? `${bestDownload.downloadSpeed} Mbps(测速)` : 'N/A');
                Logger.info('GameAcc', `✅ 下载最优: ${bestDownload.name} ${dlSpeed} ${bestDownload.region}${bestDownload.isReality?' Reality':''}${bestDownload.isDirectLine?' 直连':''}`);
            }
            SpeedtestState.updateResult('game', { name: bestOnline.name, delay: bestOnline.rawDelay, loss: bestOnline.loss, samples: bestOnline.samples });
            if (bestDownload) {
                SpeedtestState.updateDownloadResult(bestDownload.name, bestDownload.downloadSpeed);
            }
            SpeedtestState.updateGamePerNodeResults(results);
            return { name: bestOnline.name, delay: bestOnline.rawDelay, loss: bestOnline.loss, samples: bestOnline.samples, bestDownload };
        } catch (err) { Logger.error('GameAcc', '寻找最快节点时发生异常', err); return null; }
        finally { ClashService.setFullSpeedtestFlag(false); }
    }

    static async lockGameNode(nodeName, groupName = PROXY_GROUPS.GAME_ACC) {
        if (!nodeName) return false;
        try { return await ClashService.selectProxyNode(groupName, nodeName); }
        catch (err) { Logger.error('GameAcc', `锁定游戏策略组发生异常: ${groupName} -> ${nodeName}`, err); return false; }
    }

   static async findBestAndLock(force) {
        const best = await this.findFastestGameNode(true);
       if (best) {
       SpeedtestState.updateResult('game', best);
            if (force || !SpeedtestState.isLocked('game')) {
                await this.lockGameNode(best.name);
                SpeedtestState.setLockedNode('game', best.name);
            }
           // 下载组：独立锁定最优下载节点
            if (best.bestDownload) {
                const dlLocked = SpeedtestState.getLockedDownloadNode();
                if (force || !dlLocked) {
                    await this.lockGameNode(best.bestDownload.name, PROXY_GROUPS.GAME_DOWNLOAD);
                    SpeedtestState.setLockedDownloadNode(best.bestDownload.name);
                }
            }
        }
        return best;
    }

    static startGameAccMonitor() {
        if (gameAccCheckTimer || gameAccStartTimeout) return;
        gameAccStartTimeout = setTimeout(() => {
            gameAccStartTimeout = null;
            const gameMacs = this.readGameDevices();
            if (gameMacs.length === 0) return;
           Logger.info('GameAcc', '🛡️ 游戏加速故障心跳检测正式启动 (周期 5 分钟)');
            if (!ClashService.isFullSpeedtestInProgress()) {
                this._checkGameNodeHealth();
            } else {
                Logger.debug('GameAcc', '全量测速进行中，首轮心跳顺延 60 秒');
                setTimeout(() => { if (!ClashService.isFullSpeedtestInProgress()) this._checkGameNodeHealth(); }, 60000);
            }
            gameAccCheckTimer = setInterval(async () => {
                if (ClashService.isFullSpeedtestInProgress()) {
                    Logger.debug('GameAcc', '全量测速进行中，跳过本轮心跳');
                    return;
                }
                await this._checkGameNodeHealth();
            }, 600000);
        }, 120000);
        Logger.info('GameAcc', '🛡️ 游戏加速故障心跳已排程，将在 120 秒后错峰激活 (周期 10 分钟)');
    }

   static async _checkGameNodeHealth() {
       if (!this._healthFailCounts) this._healthFailCounts = {};
       const gameMacs = this.readGameDevices();
       if (gameMacs.length === 0) { this.stopGameAccMonitor(); return; }

       // 重启冷却期：重启或重载后 90s 内不执行检测（给内核就绪充足的缓冲时间）
       const lastRestartTime = SshService.getLastRestartTime?.() || 0;
       const timeSinceLastRestart = Date.now() - lastRestartTime;
       if (timeSinceLastRestart < 90000) {
           Logger.debug('GameAcc', `处于重启避让期，跳过健康心跳 (${Math.floor((90000 - timeSinceLastRestart) / 1000)}s 剩余)`);
           return;
       }

       try {
           const proxiesData = await ClashService.getProxies();
            // 分别检查联机组和下载组
            await this._checkSingleGroupHealth(proxiesData, PROXY_GROUPS.GAME_ACC,
                SpeedtestState.getLockedNode('game'), SpeedtestState.isLocked('game'));
            await this._checkSingleGroupHealth(proxiesData, PROXY_GROUPS.GAME_DOWNLOAD,
                SpeedtestState.getLockedDownloadNode(), SpeedtestState.isLocked('game'));
        } catch (err) { Logger.error('GameAcc', '故障转移心跳检测发生异常', err); }
    }

    // 单组健康检查：锁定一致性 -> 延迟测试 -> 增量测速刷新
    static async _checkSingleGroupHealth(proxiesData, groupName, lockedNode, isLocked) {
        const group = proxiesData.proxies[groupName];
        if (!group || !group.now) return;

        if (isLocked && lockedNode && group.now !== lockedNode) {
            Logger.info('GameAcc', `🛡️ ${groupName} 锁定节点不一致 (当前: ${group.now}, 预期: ${lockedNode})，自动恢复...`);
            const restored = await this.lockGameNode(lockedNode, groupName);
            if (restored) return;
        }

        const currentNode = group.now;
        if (['🚀 节点选择', '👑 高级节点', 'DIRECT'].includes(currentNode)) {
            this._healthFailCounts[currentNode] = 0;
            return;
        }
        const delay = await ClashService.testNodeDelay(currentNode, 6000, getGameNodeTestUrl(currentNode));
        if (delay === 0) {
            this._healthFailCounts[currentNode] = (this._healthFailCounts[currentNode] || 0) + 1;
            if (this._healthFailCounts[currentNode] >= 2) {
                Logger.warn('GameAcc', `⚠️ ${groupName} 节点 [${currentNode}] 连续${this._healthFailCounts[currentNode]}次断联！`);
                this._healthFailCounts[currentNode] = 0;
            } else {
                Logger.debug('GameAcc', `${groupName} 节点 [${currentNode}] 测速超时 (${this._healthFailCounts[currentNode]}/2)`);
            }
        } else {
            this._healthFailCounts[currentNode] = 0;
            // 仅联机组做增量测速刷新（下载组心跳不做大流量测试）
            if (groupName === PROXY_GROUPS.GAME_ACC) {
                try {
                    let successCount = 1;
                    let totalDelay = delay;
                    const NODE_SAMPLES = 3;
                    const TEST_URL = getGameNodeTestUrl(currentNode);
                    for (let i = 1; i < NODE_SAMPLES; i++) {
                        const d = await ClashService.testNodeDelay(currentNode, 3000, TEST_URL);
                        if (d > 0) { successCount++; totalDelay += d; }
                        await new Promise(r => setTimeout(r, 100));
                    }
                    const lossRate = (NODE_SAMPLES - successCount) / NODE_SAMPLES;
                    const avgDelay = Math.round(totalDelay / successCount);
                    SpeedtestState.updateResult('game', { name: currentNode, delay: avgDelay, loss: lossRate, samples: successCount });
                } catch (e) { Logger.debug('GameAcc', '心跳增量测速刷新失败', e); }
            }
        }
    }

    static stopGameAccMonitor() {
        if (gameAccStartTimeout) { clearTimeout(gameAccStartTimeout); gameAccStartTimeout = null; }
        if (gameAccCheckTimer) { clearInterval(gameAccCheckTimer); gameAccCheckTimer = null; Logger.info('GameAcc', '🛑 停止游戏加速节点状态守护监测进程'); }
    }
}

module.exports = GameAccService;
