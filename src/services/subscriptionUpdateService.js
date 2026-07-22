const Logger = require('../utils/logger');
const SshService = require('./sshService');

let weeklyTimer = null;

class SubscriptionUpdateService {
    // 启动每周定时更新订阅任务（每周一凌晨5:00）
    static startWeeklyUpdate() {
        if (weeklyTimer) return;

        Logger.info('SubscriptionUpdate', '📅 启动每周订阅更新定时任务（每周一 05:00）...');

        // 计算距离下周一 05:00 的毫秒数
        const now = new Date();
        const nextMonday = new Date(now);
        nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
        nextMonday.setHours(5, 0, 0, 0);
        const delayMs = nextMonday - now;

        // 首次执行
        setTimeout(async () => {
            await this.updateSubscription();
            // 之后每周执行一次
            weeklyTimer = setInterval(async () => {
                await this.updateSubscription();
            }, 7 * 24 * 60 * 60 * 1000);
        }, delayMs);

        Logger.info('SubscriptionUpdate', `下次订阅更新将在 ${nextMonday.toLocaleString('zh-CN')} 执行`);
    }

    // 执行订阅更新
    static async updateSubscription() {
        Logger.info('SubscriptionUpdate', '🔄 开始执行定时订阅更新...');
        try {
            // 1. 从路由器 config.yaml 中提取订阅 URL
            const configContent = await SshService.runRemoteCommand(
                `grep 'url:' /data/ShellCrash/config.yaml | grep -v 'health-check' | grep -v 'gstatic' | head -1 | awk '{print $2}'`
            );
            const subscriptionUrl = configContent.trim();
            if (!subscriptionUrl || !subscriptionUrl.startsWith('http')) {
                Logger.error('SubscriptionUpdate', '❌ 无法从路由器配置中提取有效的订阅链接');
                return;
            }
            Logger.info('SubscriptionUpdate', `📎 订阅链接: ${subscriptionUrl}`);

            // 2. 在路由器上直接下载新的订阅文件
            const downloadResult = await SshService.runRemoteCommand(
                `curl -k -L -s -o /tmp/subscription_new.yaml '${subscriptionUrl}' -w 'HTTP:%{http_code} SIZE:%{size_download}'`
            );
            Logger.info('SubscriptionUpdate', `📥 下载结果: ${downloadResult.trim()}`);

            if (!downloadResult.includes('HTTP:200')) {
                Logger.error('SubscriptionUpdate', `❌ 订阅链接下载失败: ${downloadResult.trim()}`);
                return;
            }

            // 3. 备份旧订阅文件并覆盖新文件
            await SshService.runRemoteCommand(
                `cp /data/ShellCrash/providers/subscription.yaml /data/ShellCrash/providers/subscription.yaml.bak && cp /tmp/subscription_new.yaml /data/ShellCrash/providers/subscription.yaml && echo '订阅文件已更新'`
            );

            // 4. 获取新文件信息
            const fileInfo = await SshService.runRemoteCommand(
                `ls -la /data/ShellCrash/providers/subscription.yaml`
            );
            Logger.info('SubscriptionUpdate', `📄 新订阅文件: ${fileInfo.trim()}`);

            // 5. 触发 Clash 热重载或重启
            // 先尝试 PUT API 热更新 provider，如果失败则重启 Clash 进程
            const apiResult = await SshService.runRemoteCommand(
                `curl -s -X PUT 'http://127.0.0.1:9999/providers/proxies/subscription' -w 'HTTP:%{http_code}'`
            );
            if (apiResult.includes('HTTP:2') || apiResult.includes('HTTP:204')) {
                Logger.info('SubscriptionUpdate', '✅ 通过 API 热更新订阅成功');
            } else {
                Logger.warn('SubscriptionUpdate', '⚠️ API 热更新失败，降级为重启 Clash 服务...');
                await SshService.runRemoteCommand(
                    `killall mihomo 2>/dev/null; sleep 2; /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null &`
                );
                // 等待 API 就绪
                for (let i = 0; i < 15; i++) {
                    const ready = await SshService.runRemoteCommand(
                        `curl -s --connect-timeout 2 http://127.0.0.1:9999/version 2>/dev/null | grep -q 'version' && echo 'ready' || echo 'waiting'`
                    );
                    if (ready.trim() === 'ready') {
                        Logger.info('SubscriptionUpdate', '✅ Clash 重启完成，API 已就绪');
                        break;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            // 6. 验证节点数量
            const nodeCount = await SshService.runRemoteCommand(
                `curl -s http://127.0.0.1:9999/providers/proxies | grep -o '"name":"[^"]*"' | grep -v 'DIRECT\\|REJECT' | wc -l`
            );
            Logger.info('SubscriptionUpdate', `📊 订阅更新完成，当前节点数: ${nodeCount.trim()}`);

        } catch (err) {
            Logger.error('SubscriptionUpdate', '❌ 订阅更新执行失败', err);
        }
    }

    // 手动触发一次订阅更新
    static async updateNow() {
        Logger.info('SubscriptionUpdate', '📢 手动触发订阅更新...');
        return await this.updateSubscription();
    }

    // 停止定时任务
    static stopWeeklyUpdate() {
        if (weeklyTimer) {
            clearInterval(weeklyTimer);
            weeklyTimer = null;
            Logger.info('SubscriptionUpdate', '⏹️ 每周订阅更新任务已停止');
        }
    }
}

module.exports = SubscriptionUpdateService;
