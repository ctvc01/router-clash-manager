document.addEventListener('DOMContentLoaded', () => {
    // 页面核心节点缓存
    const elStatusText = document.getElementById('status-text');
    const elStatusMode = document.getElementById('status-mode');
    const elCurrentNode = document.getElementById('current-node');
    const elNodeLatency = document.getElementById('node-latency');
    const elDevicesTotal = document.getElementById('devices-total');
    const elDevicesProxy = document.getElementById('devices-proxy');
    const elDiskPercent = document.getElementById('disk-percent');
    const elDiskUsed = document.getElementById('disk-used');
    const elDiskTotal = document.getElementById('disk-total');
    const elDiskProgress = document.getElementById('disk-progress');
    const elMemorySub = document.getElementById('memory-sub');
    const elTotalDownSpeed = document.getElementById('total-down-speed');
    const elTotalUpSpeed = document.getElementById('total-up-speed');
    const elSearchInput = document.getElementById('search-input');
    const elLoadingOverlay = document.getElementById('loading-overlay');
    const elLoadingText = document.getElementById('loading-text');
    const elToast = document.getElementById('toast');
    const elDeviceGrid = document.getElementById('device-grid');
    const elFilterButtons = document.getElementById('filter-buttons');
    
    // 页脚监控节点
    const elFooterVersion = document.getElementById('footer-clash-version');
    const elFooterUptime = document.getElementById('footer-uptime');
    const elFooterCpu = document.getElementById('footer-cpu');
    const elFooterMemory = document.getElementById('footer-memory');

    // [新增] 错误日志弹窗相关节点
    const elErrorLogModal = document.getElementById('error-log-modal');
    const elBtnCloseLogModal = document.getElementById('btn-close-log-modal');
    const elBtnCloseLogModalOk = document.getElementById('btn-close-log-modal-ok');
    const elErrorLogContent = document.getElementById('error-log-content');

    // [新增] 编辑模态弹窗相关节点
    const elEditModal = document.getElementById('edit-device-modal');
    const elBtnCloseModal = document.getElementById('btn-close-modal');
    const elModalMac = document.getElementById('modal-device-mac');
    const elModalIp = document.getElementById('modal-device-ip');
    const elModalNameInput = document.getElementById('modal-device-name');
    const elModalCategorySelect = document.getElementById('modal-device-category');
    const elBtnModalCancel = document.getElementById('btn-modal-cancel');
    const elBtnModalSave = document.getElementById('btn-modal-save');

    // [新增] 节点详情模态弹窗相关节点
    const elNodeDetailModal = document.getElementById('node-detail-modal');
    const elBtnCloseNodeModal = document.getElementById('btn-close-node-modal');
    const elBtnCloseNodeModalOk = document.getElementById('btn-close-node-modal-ok');
    const elNodeProxyReal = document.getElementById('node-proxy-real');
    const elNodeProxyDelay = document.getElementById('node-proxy-delay');
    const elNodeAiReal = document.getElementById('node-ai-real');
    const elNodeAiDelay = document.getElementById('node-ai-delay');
    const elNodeGameReal = document.getElementById('node-game-real');
    const elNodeGameDelay = document.getElementById('node-game-delay');
    
    // 自定义下拉菜单相关 DOM
    const elBtnToggleGameDropdown = document.getElementById('btn-toggle-game-dropdown');
    const elIconGameDropdownArrow = document.getElementById('icon-game-dropdown-arrow');
    const elGameNodeDropdownMenu = document.getElementById('game-node-dropdown-menu');
    const elGameDropdownListContainer = document.getElementById('game-dropdown-list-container');

    // AI模式下拉菜单相关 DOM
    const elBtnToggleAiDropdown = document.getElementById('btn-toggle-ai-dropdown');
    const elIconAiDropdownArrow = document.getElementById('icon-ai-dropdown-arrow');
    const elAiNodeDropdownMenu = document.getElementById('ai-node-dropdown-menu');
    const elAiDropdownListContainer = document.getElementById('ai-dropdown-list-container');

    // 代理模式下拉菜单相关 DOM
    const elBtnToggleProxyDropdown = document.getElementById('btn-toggle-proxy-dropdown');
    const elIconProxyDropdownArrow = document.getElementById('icon-proxy-dropdown-arrow');
    const elProxyNodeDropdownMenu = document.getElementById('proxy-node-dropdown-menu');
    const elProxyDropdownListContainer = document.getElementById('proxy-dropdown-list-container');

    // 自定义确认弹窗相关 DOM
    const elConfirmModal = document.getElementById('confirm-modal');
    const elConfirmTitle = document.getElementById('confirm-modal-title');
    const elConfirmMessage = document.getElementById('confirm-modal-message');
    const elBtnConfirmCancel = document.getElementById('btn-confirm-cancel');
    const elBtnConfirmOk = document.getElementById('btn-confirm-ok');


    // 全局状态管理
    let state = {
        whitelist: [],
        gameAccelerated: [],
        aiBoosted: [],
        customDevices: {},
        lanDevices: [],
        status: {},
        activeCategory: 'all',
        deviceSpeeds: {},
        systemUptimeMinutes: 20482,
        
        // 瞬态假死防抖保护
        consecutiveOfflineFailures: 0,
        isRebuilding: false,
        rebuildTimer: null,

        // 测速状态
        speedtest: { game: { lock: false, lastNode: null, lastDelay: 0, lastLoss: 0, lastSamples: '' }, ai: { lock: false, lastNode: null, lastDelay: 0, lastSamples: '' } }
    };

    // 新增元素引用
    const elCardModeDist = document.getElementById('card-mode-dist');
    const elBadgeProxyLock = document.getElementById('badge-proxy-lock');
    const elBadgeAiLock = document.getElementById('badge-ai-lock');
    const elBadgeGameLock = document.getElementById('badge-game-lock');
    const elBadgeProxyCount = document.getElementById('badge-proxy-count');
    const elBadgeAiCount = document.getElementById('badge-ai-count');
    const elBadgeGameCount = document.getElementById('badge-game-count');
    const elNodeGameLoss = document.getElementById('node-game-loss');

    // 辅助：获取设备类型的 UI 图标 (完全规范等比大小)
    function getDeviceIcon(category) {
        switch (category) {
            case 'pc':
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
            case 'phone':
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
            case 'tablet': // 平板图标
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
            case 'game':
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="3"/></svg>`;
            case 'tv': // 电视盒子图标
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="15" rx="2"/><line x1="10" y1="21" x2="14" y2="21"/><line x1="12" y1="18" x2="12" y2="21"/></svg>`;
            case 'iot':
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
            default:
                return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`;
        }
    }

    // 辅助：智能根据 Hostname 推定设备类型归类 (PC, 手机, 游戏机, IoT, 其它)
    function getDeviceCategory(hostname, mac) {
        const name = (hostname || '').toLowerCase();
        
        // 1. 根据 MAC 地址前缀与特征进行智能推定
        if (mac && typeof mac === 'string') {
            const cleanMac = mac.toLowerCase();
            // 常见的美的等智能家居 MAC 段
            const mideaPrefixes = ['44:87:63', 'c0:84:ff', '80:3e:4f', '8c:d0:b2', 'cc:4d:75'];
            if (mideaPrefixes.some(prefix => cleanMac.startsWith(prefix))) {
                return 'iot';
            }
            
            // 检查是否为本地随机 MAC 地址 (第一字节第二低位为 1，多为启用了随机 MAC 的手机)
            const firstByte = parseInt(cleanMac.slice(0, 2), 16);
            if (!isNaN(firstByte) && (firstByte & 2) !== 0) {
                return 'phone';
            }
        }
        
        if (name.includes('switch') || name.includes('nintendo') || 
            name.includes('playstation') || name.includes('ps5') || 
            name.includes('xbox') || name.includes('gaming') || name.includes('steam-deck') || name.includes('quest')) {
            return 'game';
        }
        if (name.includes('macbook') || name.includes('mac-') || name.includes('imac') || 
            name.includes('workstation') || name.includes('pc-') || name.includes('desktop') || 
            name.includes('laptop') || name.includes('windows') || name.includes('ubuntu') ||
            name.includes('nas') || name.includes('synology') || name.includes('server')) {
            return 'pc';
        }
        if (name.includes('ipad') || name.includes('tab') || name.includes('galaxy-tab')) {
            return 'tablet';
        }
        if (name.includes('iphone') || name.includes('phone') || name.includes('android') || 
            name.includes('xiaomi') || name.includes('huawei') || name.includes('oppo') || 
            name.includes('vivo') || name.includes('redmi')) {
            return 'phone';
        }
        if (name.includes('tv') || name.includes('box') || name.includes('bravia')) {
            return 'tv';
        }
        if (name.includes('light') || name.includes('purifier') || name.includes('speaker') || 
            name.includes('marshall') || name.includes('gateway') || name.includes('camera') || 
            name.includes('ipc') || name.includes('plug') || name.includes('printer') || 
            name.includes('fridge') || name.includes('homepod')) {
            return 'iot';
        }
        return 'other';
    }

    // 辅助：从类别映射为前端分类筛选器的 Tab (支持动态类型并集，不折叠)
    function getFilterTabByCategory(category) {
        return category;
    }

    // 动态生成并渲染分类筛选 Tab 按钮（根据当前在线设备所具有的实际类型的并集）
    function renderFilterTabs() {
        const categories = new Set();
        state.lanDevices.forEach(d => {
            const mac = d.mac.toLowerCase();
            const custom = state.customDevices[mac] || {};
            const category = custom.category || getDeviceCategory(d.hostname, mac);
            categories.add(category);
        });

        const categoryMap = {
            'pc': '电脑',
            'phone': '手机',
            'tablet': '平板',
            'game': '游戏主机',
            'tv': '电视/盒子',
            'iot': '智能家居',
            'other': '其他'
        };

        // 状态保护：如果之前激活的类别下线不在并集中，回退为 'all'
        if (state.activeCategory !== 'all' && !categories.has(state.activeCategory)) {
            state.activeCategory = 'all';
        }

        let html = `<button class="filter-btn ${state.activeCategory === 'all' ? 'active' : ''}" data-category="all">全部</button>`;
        
        const sortedCats = Array.from(categories).sort((a, b) => {
            const order = ['pc', 'phone', 'tablet', 'game', 'tv', 'iot', 'other'];
            return order.indexOf(a) - order.indexOf(b);
        });

        sortedCats.forEach(cat => {
            const label = categoryMap[cat] || cat;
            html += `<button class="filter-btn ${state.activeCategory === cat ? 'active' : ''}" data-category="${cat}">${label}</button>`;
        });

        elFilterButtons.innerHTML = html;
    }

    // 辅助：展示/隐藏加载遮罩
    function showLoading(text) {
        elLoadingText.textContent = text || '请稍候...';
        elLoadingOverlay.classList.add('active');
    }
    function hideLoading() {
        elLoadingOverlay.classList.remove('active');
    }

    // 辅助：Toast 弹窗提示
    function showToast(message) {
        elToast.textContent = message;
        elToast.classList.add('show');
        setTimeout(() => {
            elToast.classList.remove('show');
        }, 3000);
    }

    // 辅助：重载过渡态切换函数
    function startRebuildState() {
        state.isRebuilding = true;
        if (state.rebuildTimer) {
            clearTimeout(state.rebuildTimer);
        }
        
        updateUiForRebuilding();
        
        // 最大 20 秒保护时间，超时后自动恢复
        state.rebuildTimer = setTimeout(() => {
            stopRebuildState();
        }, 20000);
    }
    
    function stopRebuildState() {
        if (!state.isRebuilding) return;
        state.isRebuilding = false;
        if (state.rebuildTimer) {
            clearTimeout(state.rebuildTimer);
            state.rebuildTimer = null;
        }
        // 恢复正常轮询拉取状态
        fetchStatus();
    }
    
    function updateUiForRebuilding() {
        elStatusText.textContent = '重载中';
        elStatusText.className = 'card-value text-orange animate-pulse';
        elStatusMode.innerHTML = '<span style="color: #ffb786;">正在热重载分流策略...</span>';
        
        elCurrentNode.textContent = '请稍候';
        elCurrentNode.classList.remove('long-text');
        elNodeLatency.textContent = '延迟: --';
        
        elFooterVersion.textContent = '内核版本: 重载中 (Mihomo)';
        elFooterCpu.textContent = 'CPU: --';
    }

    // 辅助：HTML 特殊字符转义防 XSS (C4)
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // 辅助：防抖函数 (H4)
    function debounce(fn, delay) {
        let timer;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // 辅助：格式化运行时间 (分钟转 "已启动 X天 XX时 XX分")
    function formatUptime(totalMinutes) {
        const days = Math.floor(totalMinutes / (24 * 60));
        const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const mins = totalMinutes % 60;
        return `运行时间: ${days}天 ${hours.toString().padStart(2, '0')}时 ${mins.toString().padStart(2, '0')}分`;
    }

    // 格式化网关状态启动时长 "已启动 X天 XX时 XX分"
    function formatGatewayUptime(totalMinutes) {
        const days = Math.floor(totalMinutes / (24 * 60));
        const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const mins = totalMinutes % 60;
        if (days > 0) return `已启动 ${days}天${hours}时${mins}分`;
        if (hours > 0) return `已启动 ${hours}时${mins}分`;
        return `已启动 ${mins}分`;
    }

    // 辅助：格式化网速输出
    function formatSpeed(bytesPerSec) {
        if (bytesPerSec === 0) return '0.0K';
        const kb = bytesPerSec / 1024;
        if (kb >= 1024) {
            return `${(kb / 1024).toFixed(1)}M`;
        }
        return `${kb.toFixed(1)}K`;
    }

    // 汇总真实实时流量，并渲染顶部全局流量药丸
    function updateRealSpeeds() {
        let totalDown = 0;
        let totalUp = 0;

        state.lanDevices.forEach(d => {
            const mac = d.mac;
            const speed = state.deviceSpeeds[mac] || { down: 0, up: 0 };
            totalDown += speed.down;
            totalUp += speed.up;
        });

        elTotalDownSpeed.textContent = formatSpeed(totalDown) + '/s';
        elTotalUpSpeed.textContent = formatSpeed(totalUp) + '/s';
    }

    // 更新顶部代理设备数量统计，只统计当前在线且处于非直连（即代理、游戏、AI强化）状态的设备数
    function updateDevicesProxyCount() {
        let proxyCount = 0, aiCount = 0, gameCount = 0;
        state.lanDevices.forEach(d => {
            const mac = d.mac.toLowerCase();
            if (state.whitelist.includes(mac)) proxyCount++;
            if (state.aiBoosted.includes(mac)) aiCount++;
            if (state.gameAccelerated.includes(mac)) gameCount++;
        });
        const total = proxyCount + aiCount + gameCount;
        elDevicesProxy.textContent = total;

        const barP = document.getElementById('mode-bar-proxy');
        const barA = document.getElementById('mode-bar-ai');
        const barG = document.getElementById('mode-bar-game');
        const labP = document.getElementById('label-proxy');
        const labA = document.getElementById('label-ai');
        const labG = document.getElementById('label-game');

        const modes = [
            { count: proxyCount, bar: barP, lab: labP, name: '代理' },
            { count: aiCount,    bar: barA, lab: labA, name: 'AI' },
            { count: gameCount,  bar: barG, lab: labG, name: '游戏' }
        ];

        if (total === 0) {
            [barP, barA, barG].forEach(b => b && (b.style.flex = '0'));
            [labA, labG].forEach(l => l && (l.style.display = 'none'));
            if (labP) { labP.style.display = ''; labP.style.flex = ''; labP.textContent = '代理 0'; }
            return;
        }

        modes.forEach(m => {
            if (!m.bar || !m.lab) return;
            m.bar.style.flex = m.count;
            if (m.count > 0) {
                m.lab.style.display = '';
                m.lab.style.flex = m.count;
                m.lab.textContent = m.name + ' ' + m.count;
            } else {
                m.lab.style.display = 'none';
                m.lab.style.flex = '';
            }
        });
    }

    // 接口：获取 Clash 服务状态与监控数据的真实联动
    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) throw new Error();
            const data = await res.json();
            
            // 只要成功拿到数据，重置连续失败计数器
            state.consecutiveOfflineFailures = 0;
            
            // 重载过渡态自愈判断
            if (state.isRebuilding) {
                const isLoadingState = data.currentNode === '未知' || data.version === '未知' || data.mode === '未知';
                if (data.running && !isLoadingState) {
                    // 内核已成功起来且数据加载就绪，提前结束过渡态
                    stopRebuildState();
                } else {
                    // 如果虽然请求通了但内核还在重启中，保持重载 UI
                    state.status = data;
                    return;
                }
            }

            state.status = data;
            
            if (data.running) {
                const isLoadingState = data.currentNode === '未知' || data.version === '未知' || data.mode === '未知';

                if (isLoadingState) {
                    elStatusText.textContent = '加载中';
                    elStatusText.className = 'card-value text-orange';
                    elStatusMode.textContent = '';
                    // 即使加载中也更新 uptime state（但不显示）
                    if (data.uptime && data.uptime > 0) {
                        state.systemUptimeMinutes = Math.round(data.uptime / 60);
                    }
                    elCurrentNode.textContent = '加载中';
                    elCurrentNode.classList.remove('long-text');
                    elNodeLatency.textContent = '';
                } else {
                    elStatusText.textContent = '运行中';
                    elStatusText.className = 'card-value text-green';
                    if (data.uptime && data.uptime > 0) {
                        state.systemUptimeMinutes = Math.round(data.uptime / 60);
                        elStatusMode.textContent = formatGatewayUptime(state.systemUptimeMinutes);
                    } else {
                        state.systemUptimeMinutes = 0;
                        elStatusMode.textContent = '计算中...';
                    }
                    
                    // 更新当前节点与延迟
                    elCurrentNode.textContent = data.currentNode;
                    const threshold = window.innerWidth <= 480 ? 10 : 15;
                    if (data.currentNode.length > threshold) {
                        elCurrentNode.classList.add('long-text');
                    } else {
                        elCurrentNode.classList.remove('long-text');
                    }
                    
                    if (data.latency && data.latency > 0) {
                        elNodeLatency.textContent = `延迟: ${data.latency}ms`;
                    } else {
                        elNodeLatency.textContent = `延迟: --`;
                    }
                }
                
                // 磁盘占用完全真实联动
                const diskUsedMB = parseInt(data.diskUsed) || 0;
                const diskTotalMB = parseInt(data.diskTotal) || 20;
                const memUsed = data.memory || '';
                const memTotal = data.totalMemory || '';
                updateDiskBar(diskUsedMB, diskTotalMB, memUsed, memTotal);
                
                elFooterUptime.textContent = formatUptime(state.systemUptimeMinutes);
                
                elFooterVersion.textContent = `内核版本: ${data.version} (Mihomo)`;
                elFooterCpu.textContent = `CPU: ${data.cpu}`;
            } else {
                updateDiskBar(0, 20, '--', '--');
                elStatusText.textContent = '已停止';
                elStatusText.className = 'card-value text-muted';
                elStatusMode.innerHTML = `<span class="error-log-link" id="view-error-log" style="color: var(--danger); text-decoration: underline; cursor: pointer; font-size: 11px;">错误日志</span>`;
                
                // 停止时隐藏展示节点
                elCurrentNode.textContent = '已关闭';
                elCurrentNode.classList.remove('long-text');
                elNodeLatency.textContent = '延迟: --';
                
                elFooterVersion.textContent = '内核版本: 未知 (Mihomo)';
                elFooterCpu.textContent = 'CPU: 0.0%';
            }
        } catch (e) {
            // 如果处于重载过渡态，静默忽略此次异常
            if (state.isRebuilding) {
                return;
            }
            
            // 递增连续失败计数
            state.consecutiveOfflineFailures++;
            
            // 如果连续失败次数小于 3，展示“连接中”黄色过渡状态
            if (state.consecutiveOfflineFailures < 3) {
                elStatusText.textContent = '连接中';
                elStatusText.className = 'card-value text-orange animate-pulse';
                elStatusMode.innerHTML = `正在尝试重新连接 (${state.consecutiveOfflineFailures}/3)...`;
                
                elCurrentNode.textContent = '已关闭';
                elCurrentNode.classList.remove('long-text');
                elNodeLatency.textContent = '延迟: --';
                return;
            }

            // 达到 3 次连续失败，正式判定为离线/未知
            updateDiskBar(0, 20);
            elStatusText.textContent = '离线/未知';
            elStatusText.className = 'card-value text-muted';
            elStatusMode.innerHTML = '无法与后端通信';
            
            elCurrentNode.textContent = '已关闭';
            elCurrentNode.classList.remove('long-text');
            elNodeLatency.textContent = '延迟: --';
            
            elFooterVersion.textContent = '内核版本: 离线 (Mihomo)';
            elFooterCpu.textContent = 'CPU: --';
            elFooterMemory.textContent = '磁盘: -- / 20MB';
        }
    }

    function updateDiskBar(usedMB, totalMB, memUsed, memTotal) {
        totalMB = totalMB || 20;
        elDiskPercent.textContent = Math.round((usedMB / totalMB) * 100) + '%';
        elDiskUsed.textContent = usedMB;
        elDiskTotal.textContent = totalMB;
        const percent = Math.round((usedMB / totalMB) * 100);
        elDiskProgress.style.width = `${percent}%`;
        
        // 动态警示色联动
        elDiskProgress.classList.remove('warning-bar', 'danger-bar');
        elDiskPercent.classList.remove('text-green', 'text-yellow', 'text-red');
        
        if (percent >= 90) {
            elDiskProgress.classList.add('danger-bar');
            elDiskPercent.classList.add('text-red');
        } else if (percent >= 75) {
            elDiskProgress.classList.add('warning-bar');
            elDiskPercent.classList.add('text-yellow');
        } else {
            elDiskPercent.classList.add('text-green');
        }
        
        elFooterMemory.textContent = `磁盘: ${usedMB}MB / ${totalMB}MB`;
        if (elMemorySub) {
            // 防御性格式化：如果后端返回的数据中已经带有 MB 单位，则不重复追加
            const formattedUsed = memUsed && typeof memUsed === 'string' && memUsed.includes('MB') ? memUsed.trim() : (memUsed ? `${memUsed}MB` : '--');
            const formattedTotal = memTotal && typeof memTotal === 'string' && memTotal.includes('MB') ? memTotal.trim() : (memTotal ? `${memTotal}MB` : '--');
            elMemorySub.textContent = `实时内存 ${formattedUsed} / ${formattedTotal}`;
        }
    }

    // 接口：获取加速的游戏设备 MAC 列表
    async function fetchGameList() {
        try {
            const res = await fetch('/api/game/list');
            if (!res.ok) throw new Error();
            const data = await res.json();
            state.gameAccelerated = data.map(m => m.toLowerCase());
        } catch (e) {
            // 离线回退保持初始值
        }
    }

    // 接口：获取局域网设备，合入自定义别名和分类
    async function fetchDevices() {
        try {
            const res = await fetch('/api/devices');
            if (!res.ok) throw new Error();
            const data = await res.json();
            
            state.whitelist = data.whitelist.map(m => m.toLowerCase());
            state.gameAccelerated = (data.gameList || []).map(m => m.toLowerCase());
            state.aiBoosted = (data.aiList || []).map(m => m.toLowerCase());
            state.customDevices = data.custom || {};
            
            // 仅使用真实局域网在线设备并同步真实流速
            const remoteDevices = data.lan_devices.map(device => {
                const mac = device.mac.toLowerCase();
                state.deviceSpeeds[mac] = {
                    down: device.rx_rate || 0,
                    up: device.tx_rate || 0
                };
                return {
                    mac: mac,
                    ip: device.ip,
                    hostname: device.hostname === '*' ? '未知设备' : device.hostname
                };
            });

            state.lanDevices = remoteDevices;
            
            // 统计大卡片
            elDevicesTotal.textContent = state.lanDevices.length + ' 在线';
            updateDevicesProxyCount();
            
            renderFilterTabs();
            updateRealSpeeds();
            renderGrid();
        } catch (e) {
            console.error('获取设备列表异常 (前端):', e);
            // 容错设计：如果本地已经存有在线设备，在短时间异常时保留上一次渲染结果，不强制清空导致白屏
            if (state.lanDevices && state.lanDevices.length > 0) {
                return;
            }
            // 只有当本地没有历史数据时才降级为空列表
            state.lanDevices = [];
            elDevicesTotal.textContent = 0;
            elDevicesProxy.textContent = 0;
            
            renderFilterTabs();
            updateRealSpeeds();
            renderGrid();
        }
    }

    // 逻辑：向白名单添加设备 (C6: 先请求后更新状态)
    async function addDevice(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/whitelist/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || data.details || '添加白名单失败');
        }
        
        if (!state.whitelist.includes(mac)) {
            state.whitelist.push(mac);
        }
        
        updateDevicesProxyCount();
        renderGrid();
    }

    // 逻辑：从白名单移出设备 (C6: 先请求后更新状态)
    async function removeDevice(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/whitelist/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || data.details || '移出白名单失败');
        }
        
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        updateDevicesProxyCount();
        renderGrid();
    }

    // [新增] 开启游戏加速 (C6: 先请求后更新状态)
    async function enableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/game/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        if (!state.gameAccelerated.includes(mac)) {
            state.gameAccelerated.push(mac);
        }
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        showToast('Switch 游戏加速通道已就绪，已选测最佳低延迟专线节点！');
    }

    // [新增] 关停游戏加速 (C6: 先请求后更新状态)
    async function disableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/game/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        state.gameAccelerated = state.gameAccelerated.filter(m => m !== mac);
        
        showToast('游戏加速通道已成功关停，规则已重载！');
    }

    // [新增] 开启 AI 强化 (C6: 先请求后更新状态)
    async function enableAi(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/ai/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        if (!state.aiBoosted.includes(mac)) {
            state.aiBoosted.push(mac);
        }
        state.whitelist = state.whitelist.filter(m => m !== mac);
        state.gameAccelerated = state.gameAccelerated.filter(m => m !== mac);
        
        showToast('AI 极速分流通道已就绪，已自动寻优至最速 Google 节点！');
    }

    // [新增] 关停 AI 强化 (C6: 先请求后更新状态)
    async function disableAi(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        const res = await fetch('/api/ai/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        state.aiBoosted = state.aiBoosted.filter(m => m !== mac);
        
        showToast('AI 强化通道已成功关停，规则已重载！');
    }

    // [新增逻辑] 提交自定义名称与类别属性
    async function saveDeviceCustom(mac, name, category) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        // 乐观锁直接在前端更新本地缓存以避免闪烁
        state.customDevices[mac] = {
            name: name || "",
            category: category || "other"
        };
        
        showLoading('正在保存自定义属性并同步数据...');
        try {
            const res = await fetch('/api/devices/custom', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac: mac, name: name, category: category })
            });
            if (!res.ok) throw new Error();
            showToast('配置成功！已应用您定义的别名和图标。');
            
            // 隐藏弹窗
            elEditModal.classList.remove('active');
            
            // 重新拉取
            await fetchDevices();
        } catch (e) {
            showToast('保存成功（本地缓存生效，后端合流降级）');
            elEditModal.classList.remove('active');
            renderGrid();
        } finally {
            hideLoading();
        }
    }

    // 渲染：动态生成设备卡片
    function renderGrid() {
        const query = elSearchInput.value.toLowerCase().trim();
        elDeviceGrid.innerHTML = '';
        
        let filteredCount = 0;

        // 对设备在线状态进行排序：游戏模式 > AI 模式 > 代理模式 > 直连模式
        const sortedDevices = [...state.lanDevices].sort((a, b) => {
            const aMac = a.mac.toLowerCase();
            const bMac = b.mac.toLowerCase();
            
            const aMode = state.gameAccelerated.includes(aMac) ? 'game' : (state.aiBoosted.includes(aMac) ? 'ai' : (state.whitelist.includes(aMac) ? 'proxy' : 'direct'));
            const bMode = state.gameAccelerated.includes(bMac) ? 'game' : (state.aiBoosted.includes(bMac) ? 'ai' : (state.whitelist.includes(bMac) ? 'proxy' : 'direct'));
            
            const modeWeight = { 'game': 3, 'ai': 2, 'proxy': 1, 'direct': 0 };
            
            // 模式权重高者排在前面
            if (modeWeight[aMode] !== modeWeight[bMode]) {
                return modeWeight[bMode] - modeWeight[aMode];
            }
            
            // 第二维度：根据 IP 数字顺序排序
            return a.ip.localeCompare(b.ip, undefined, { numeric: true, sensitivity: 'base' });
        });

        sortedDevices.forEach(d => {
            const mac = d.mac.toLowerCase();
            
            // 自定义别名和类型的匹配
            const custom = state.customDevices[mac] || {};
            let displayName = (custom.name || d.hostname || '').trim();
            if (displayName === '未知设备' || displayName === '*') {
                displayName = '未知设备';
            }
            const category = custom.category || getDeviceCategory(d.hostname, mac);
            
            // 1. 分类 Tab 筛选 (处理 tablet->phone, tv->iot 的归类)
            const tabGroup = getFilterTabByCategory(category);
            if (state.activeCategory !== 'all' && tabGroup !== state.activeCategory) {
                return;
            }
            
            // 2. 搜索检索 (模糊检索主机名、IP、MAC)
            if (query && !displayName.toLowerCase().includes(query) && !d.ip.includes(query) && !mac.includes(query)) {
                return;
            }
            
            filteredCount++;
            
            const isOffline = false;
            
            // 状态逻辑判断
            let activeMode = 'direct';
            if (state.gameAccelerated.includes(mac)) {
                activeMode = 'game';
            } else if (state.aiBoosted.includes(mac)) {
                activeMode = 'ai';
            } else if (state.whitelist.includes(mac)) {
                activeMode = 'proxy';
            }

            const avatarSvg = getDeviceIcon(category);
            const speed = state.deviceSpeeds[mac] || { down: 0, up: 0 };
            
            // 模式选择控制器：
            // 1. 只有电脑(pc)、平板(tablet)、手机(phone) 3 种类型的设备才提供直连/代理/AI 强化三态
            // 2. 游戏主机(game)提供直连/游戏双态
            // 3. 其它类型(tv, iot, other等)默认仅提供直连/代理双态
            let controlHtml = '';
            if (['pc', 'phone', 'tablet'].includes(category)) {
                controlHtml = `
                    <div class="segmented-control">
                        <button class="segment-btn ${activeMode === 'direct' ? 'active direct-active' : ''}" data-mac="${mac}" data-action="direct">直连</button>
                        <button class="segment-btn ${activeMode === 'proxy' ? 'active proxy-active' : ''}" data-mac="${mac}" data-action="proxy">代理</button>
                        <button class="segment-btn ${activeMode === 'ai' ? 'active ai-active' : ''}" data-mac="${mac}" data-action="ai">AI强化</button>
                    </div>
                `;
            } else if (category === 'game') {
                controlHtml = `
                    <div class="segmented-control">
                        <button class="segment-btn ${activeMode === 'game' ? '' : 'active direct-active'}" data-mac="${mac}" data-action="direct">直连</button>
                        <button class="segment-btn ${activeMode === 'game' ? 'active game-active' : ''}" data-mac="${mac}" data-action="game">游戏</button>
                    </div>
                `;
            } else {
                controlHtml = `
                    <div class="segmented-control">
                        <button class="segment-btn ${activeMode === 'direct' ? 'active direct-active' : ''}" data-mac="${mac}" data-action="direct">直连</button>
                        <button class="segment-btn ${activeMode === 'proxy' ? 'active proxy-active' : ''}" data-mac="${mac}" data-action="proxy">代理</button>
                    </div>
                `;
            }

            const card = document.createElement('div');
            card.className = `device-card ${isOffline ? 'offline' : ''}`;
            card.innerHTML = `
                <!-- Top Row -->
                <div class="card-top-row">
                    <div class="device-avatar-name">
                        <div class="device-avatar">
                            ${avatarSvg}
                        </div>
                        <div class="device-title-wrapper" data-ip-display="IP: ${escapeHtml(d.ip)}">
                            <div class="device-name-row">
                                <span class="device-name-text">${escapeHtml(displayName)}</span>
                                <button class="btn-edit-device" data-mac="${mac}" data-ip="${escapeHtml(d.ip)}" data-name="${escapeHtml(custom.name || '')}" data-category="${category}" title="编辑名称和分类">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <!-- 右上角状态与速度混合容器 -->
                    <div class="device-status-right">
                        <div class="device-status-pill">
                            <span class="status-indicator-dot ${isOffline ? 'indicator-offline' : 'indicator-online'}"></span>
                            <span class="status-indicator-text ${isOffline ? 'text-muted' : 'text-green'}">${isOffline ? '离线' : '在线'}</span>
                        </div>
                        <div class="device-traffic-stats-mini">
                            <div class="device-speed-item text-orange">
                                <span class="speed-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 5v14M19 12l-7 7-7-7"/>
                                    </svg>
                                </span>
                                <span>${formatSpeed(speed.down)}</span>
                            </div>
                            <div class="device-speed-item text-green">
                                <span class="speed-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 19V5M5 12l7-7 7 7"/>
                                    </svg>
                                </span>
                                <span>${formatSpeed(speed.up)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Mid Row -->
                <div class="card-mid-row">
                    <span class="device-ip-text">IP: ${escapeHtml(d.ip)}</span>
                    <span class="device-mac-text">MAC: ${escapeHtml(mac.toUpperCase())}</span>
                </div>

                <!-- Bottom Row -->
                <div class="card-bottom-row">
                    <div class="device-traffic-stats">
                        <div class="device-speed-item text-orange">
                            <span class="speed-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 5v14M19 12l-7 7-7-7"/>
                                </svg>
                            </span>
                            <span>${formatSpeed(speed.down)}</span>
                        </div>
                        <div class="device-speed-item text-green">
                            <span class="speed-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 19V5M5 12l7-7 7 7"/>
                                </svg>
                            </span>
                            <span>${formatSpeed(speed.up)}</span>
                        </div>
                    </div>
                    ${controlHtml}
                </div>
            `;
            elDeviceGrid.appendChild(card);
        });

        if (filteredCount === 0) {
            elDeviceGrid.innerHTML = `
                <div class="device-card-loading">
                    没有找到符合筛选条件的联网设备。
                </div>
            `;
        }
    }

    // 绑定事件：三态与双态模式切换点击 (事件委托)
    elDeviceGrid.addEventListener('click', async (e) => {
        const btn = e.target.closest('.segment-btn');
        if (!btn) return;

        if (state.isRebuilding) {
            showToast('分流策略热重载中，请稍候再试...');
            return;
        }

        const mac = btn.getAttribute('data-mac').toLowerCase();
        const action = btn.getAttribute('data-action');
        
        if (!mac || !action) return;
        if (btn.classList.contains('active')) return;

        showLoading('正在切换网络分流策略并热重载内核...');
        startRebuildState();
        try {
            if (action === 'direct') {
                // 切直连
                if (state.gameAccelerated.includes(mac)) {
                    await disableGame(mac);
                }
                if (state.aiBoosted.includes(mac)) {
                    await disableAi(mac);
                }
                await removeDevice(mac);
            } 
            else if (action === 'proxy') {
                // 切代理
                if (state.gameAccelerated.includes(mac)) {
                    await disableGame(mac);
                }
                if (state.aiBoosted.includes(mac)) {
                    await disableAi(mac);
                }
                await addDevice(mac);
            } 
            else if (action === 'game') {
                // 切游戏加速 (AND 规则插入)
                if (state.aiBoosted.includes(mac)) {
                    await disableAi(mac);
                }
                await enableGame(mac);
            }
            else if (action === 'ai') {
                // 切 AI 强化
                if (state.gameAccelerated.includes(mac)) {
                    await disableGame(mac);
                }
                await enableAi(mac);
            }
            // 切换完成后，重新获取设备状态，确保数据跟后端完全一致！
            await fetchDevices();
        } catch (err) {
            console.error('切换网络模式失败:', err);
            showToast('模式切换失败，网关配置已安全回滚！\n原因: ' + err.message);
            stopRebuildState();
        } finally {
            hideLoading();
        }
    });

    // 绑定事件：设备卡片编辑按钮点击 (拉起 Modal 弹窗)
    elDeviceGrid.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.btn-edit-device');
        if (!editBtn) return;

        const mac = editBtn.getAttribute('data-mac').toLowerCase();
        const ip = editBtn.getAttribute('data-ip');
        const name = editBtn.getAttribute('data-name');
        const category = editBtn.getAttribute('data-category');

        // 回显数据到弹窗中
        elModalMac.textContent = mac.toUpperCase();
        elModalIp.textContent = ip;
        elModalNameInput.value = name || '';
        elModalCategorySelect.value = category || 'other';

        // 提取默认的主机名用作编辑框的 placeholder 提示占位
        const dev = state.lanDevices.find(item => item.mac === mac) || {};
        let rawHostname = dev.hostname || '未知设备';
        if (rawHostname === '未知设备' || rawHostname === '*') {
            rawHostname = '未知设备';
        }
        elModalNameInput.placeholder = rawHostname;

        // 显示弹窗
        elEditModal.classList.add('active');
    });

    // 绑定事件：分类过滤选择
    elFilterButtons.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;

        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        state.activeCategory = btn.getAttribute('data-category');
        renderGrid();
    });

    // 绑定事件：搜索输入 (H4: 添加 200ms 防抖)
    elSearchInput.addEventListener('input', debounce(() => {
        renderGrid();
    }, 200));

    // [新增事件] 模态弹窗 Modal 的操作事件绑定
    elBtnCloseModal.addEventListener('click', () => {
        elEditModal.classList.remove('active');
    });

    elBtnModalCancel.addEventListener('click', () => {
        elEditModal.classList.remove('active');
    });



    elBtnModalSave.addEventListener('click', () => {
        const mac = elModalMac.textContent.toLowerCase();
        const customName = elModalNameInput.value.trim();
        const customCategory = elModalCategorySelect.value;
        
        saveDeviceCustom(mac, customName, customCategory);
    });

    // [新增] 缓存上次选择的节点，用于二次确认取消时回滚
    let lastSelectedGameNode = '';

    // 辅助：获取延迟的颜色等级 Class
    function getDelayClass(delay) {
        if (!delay || delay <= 0) return 'text-muted';
        if (delay < 100) return 'text-green';
        if (delay < 200) return 'text-orange';
        return 'text-red';
    }

    // 辅助：开关游戏下拉菜单组件
    function toggleGameDropdown() {
        const isClosed = elGameNodeDropdownMenu.style.display === 'none';
        if (isClosed) {
            openGameDropdown();
        } else {
            closeGameDropdown();
        }
    }

    // 自定义确认弹窗（替代浏览器原生 confirm）
    function showConfirm({ title = '确认操作', message = '', okText = '确认', danger = false } = {}) {
        return new Promise((resolve) => {
            elConfirmTitle.textContent = title;
            elConfirmMessage.textContent = message;
            elBtnConfirmOk.textContent = okText;
            // 切换危险操作风格
            if (danger) {
                elBtnConfirmOk.classList.add('btn-danger');
            } else {
                elBtnConfirmOk.classList.remove('btn-danger');
            }
            elConfirmModal.classList.add('active');

            // H6: 使用 onclick 直接覆盖替代克隆 DOM，避免缓存引用失效
            elBtnConfirmOk.onclick = () => {
                elConfirmModal.classList.remove('active');
                resolve(true);
            };
            elBtnConfirmCancel.onclick = () => {
                elConfirmModal.classList.remove('active');
                resolve(false);
            };
        });
    }

    function openGameDropdown() {
        closeAiDropdown();
        closeProxyDropdown();
        
        const triggerRect = elBtnToggleGameDropdown.getBoundingClientRect();
        
        elGameNodeDropdownMenu.style.display = 'block';
        elGameNodeDropdownMenu.style.top = (triggerRect.bottom + 6) + 'px';
        elGameNodeDropdownMenu.style.left = triggerRect.left + 'px';
        
        // 宽度与触发按钮完全一致，实现完美水平对齐
        elGameNodeDropdownMenu.style.width = triggerRect.width + 'px';
        elGameNodeDropdownMenu.style.minWidth = '240px';
        elGameNodeDropdownMenu.style.maxWidth = '90vw';
        
        elGameNodeDropdownMenu.classList.add('animate-dropdown');
        elIconGameDropdownArrow.textContent = 'expand_less';
    }

    function closeGameDropdown() {
        elGameNodeDropdownMenu.style.display = 'none';
        elGameNodeDropdownMenu.classList.remove('animate-dropdown');
        elGameNodeDropdownMenu.style.top = '';
        elGameNodeDropdownMenu.style.left = '';
        elGameNodeDropdownMenu.style.width = '';
        elGameNodeDropdownMenu.style.minWidth = '';
        elGameNodeDropdownMenu.style.maxWidth = '';
        elIconGameDropdownArrow.textContent = 'expand_more';
    }

    // AI模式下拉菜单操作函数
    function toggleAiDropdown() {
        const isClosed = elAiNodeDropdownMenu.style.display === 'none';
        if (isClosed) {
            openAiDropdown();
        } else {
            closeAiDropdown();
        }
    }

    function openAiDropdown() {
        closeGameDropdown();
        closeProxyDropdown();
        
        const triggerRect = elBtnToggleAiDropdown.getBoundingClientRect();

        elAiNodeDropdownMenu.style.display = 'block';
        elAiNodeDropdownMenu.style.top = (triggerRect.bottom + 6) + 'px';
        elAiNodeDropdownMenu.style.left = triggerRect.left + 'px';
        elAiNodeDropdownMenu.style.width = triggerRect.width + 'px';
        elAiNodeDropdownMenu.style.minWidth = '240px';
        elAiNodeDropdownMenu.style.maxWidth = '90vw';

        elAiNodeDropdownMenu.classList.add('animate-dropdown');
        elIconAiDropdownArrow.textContent = 'expand_less';
    }

    function closeAiDropdown() {
        elAiNodeDropdownMenu.style.display = 'none';
        elAiNodeDropdownMenu.classList.remove('animate-dropdown');
        elAiNodeDropdownMenu.style.top = '';
        elAiNodeDropdownMenu.style.left = '';
        elAiNodeDropdownMenu.style.width = '';
        elAiNodeDropdownMenu.style.minWidth = '';
        elAiNodeDropdownMenu.style.maxWidth = '';
        elIconAiDropdownArrow.textContent = 'expand_more';
    }

    // 代理模式下拉菜单操作函数
    function toggleProxyDropdown() {
        const isClosed = elProxyNodeDropdownMenu.style.display === 'none';
        if (isClosed) {
            openProxyDropdown();
        } else {
            closeProxyDropdown();
        }
    }

    function openProxyDropdown() {
        closeGameDropdown();
        closeAiDropdown();
        
        const triggerRect = elBtnToggleProxyDropdown.getBoundingClientRect();

        elProxyNodeDropdownMenu.style.display = 'block';
        elProxyNodeDropdownMenu.style.top = (triggerRect.bottom + 6) + 'px';
        elProxyNodeDropdownMenu.style.left = triggerRect.left + 'px';
        elProxyNodeDropdownMenu.style.width = triggerRect.width + 'px';
        elProxyNodeDropdownMenu.style.minWidth = '240px';
        elProxyNodeDropdownMenu.style.maxWidth = '90vw';

        elProxyNodeDropdownMenu.classList.add('animate-dropdown');
        elIconProxyDropdownArrow.textContent = 'expand_less';
    }

    function closeProxyDropdown() {
        elProxyNodeDropdownMenu.style.display = 'none';
        elProxyNodeDropdownMenu.classList.remove('animate-dropdown');
        elProxyNodeDropdownMenu.style.top = '';
        elProxyNodeDropdownMenu.style.left = '';
        elProxyNodeDropdownMenu.style.width = '';
        elProxyNodeDropdownMenu.style.minWidth = '';
        elProxyNodeDropdownMenu.style.maxWidth = '';
        elIconProxyDropdownArrow.textContent = 'expand_more';
    }

    // [新增] 获取测速状态
    async function fetchSpeedtestStatus() {
        try {
            const res = await fetch('/api/speedtest/status');
            const data = await res.json();
            state.speedtest = data;
            updateLockBadges();
        } catch (e) {
            console.warn('获取测速状态失败', e);
        }
    }

    // 更新 LOCK/UNLOCK 徽标（统一颜色：绿色 UNLOCK，橙色 LOCKED）
    function updateLockBadges() {
        const game = state.speedtest.game || {};
        const ai = state.speedtest.ai || {};
        const updateBadge = (el, locked) => {
            if (!el) return;
            el.textContent = locked ? 'LOCKED' : 'UNLOCK';
            el.className = locked ? 'badge-status badge-locked' : 'badge-status badge-unlocked';
            el.style.cursor = 'pointer';
        };
        updateBadge(elBadgeGameLock, game.lock);
        updateBadge(elBadgeAiLock, ai.lock);
        updateBadge(elBadgeProxyLock, false);
    }

    // LOCK/UNLOCK 切换
    async function toggleLock(mode) {
        const current = state.speedtest[mode] || {};
        const newLock = !current.lock;
        try {
            const res = await fetch('/api/speedtest/lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, lock: newLock })
            });
            const data = await res.json();
            state.speedtest[mode] = data;
            updateLockBadges();
            showToast(newLock ? `${mode === 'ai' ? 'AI' : 'Game'} 已锁定` : `${mode === 'ai' ? 'AI' : 'Game'} 已解锁`);
        } catch (e) {
            showToast('操作失败');
        }
    }

    // [新增] 打开节点详情弹窗函数
    async function openNodeDetailModal(nocache = false) {
        showLoading('正在获取各分流模式的节点详情...');
        closeGameDropdown();
        closeAiDropdown();
        closeProxyDropdown();

        const groupKeywords = ['选择', '自动', 'DIRECT', 'GLOBAL', '测速'];
        const hkKeywords = ['hk', 'hongkong', '香港', '港'];
        
        try {
            const url = nocache ? '/api/nodes?nocache=1' : '/api/nodes';
            const res = await fetch(url);
            if (!res.ok) throw new Error('接口状态异常');
            const data = await res.json();
            if (data.status !== 'success' || !data.proxies) {
                throw new Error(data.message || '获取节点数据失败');
            }

            const proxies = data.proxies;

            // 防守性检查：确保所有对象存在
            const proxy = proxies.proxy || {};
            const ai = proxies.ai || {};
            const game = proxies.game || {};

            // 1. 回显：网页代理
            elNodeProxyReal.textContent = proxy.realNode || '--';
            elNodeProxyDelay.textContent = proxy.delay > 0 ? `${proxy.delay} ms` : '-- ms';
            elNodeProxyDelay.className = `${getDelayClass(proxy.delay)} flex-shrink-0`;
            // count badge: physical nodes with valid delay
            const proxyPhysical = (proxy.all || []).filter(n => n && n.name && !groupKeywords.some(k => n.name.includes(k)));
            const proxyValid = proxyPhysical.filter(n => n.delay > 0).length;
            if (elBadgeProxyCount) elBadgeProxyCount.textContent = proxyValid || proxyPhysical.length;

            // 2. 回显：AI强化
            elNodeAiReal.textContent = ai.realNode || '--';
            elNodeAiDelay.textContent = ai.delay > 0 ? `${ai.delay} ms` : '-- ms';
            elNodeAiDelay.className = `${getDelayClass(ai.delay)} flex-shrink-0`;
            const aiPhysical = (ai.all || []).filter(n => n && n.name && !groupKeywords.some(k => n.name.includes(k)) && !hkKeywords.some(k => n.name.toLowerCase().includes(k)));
            const aiValid = aiPhysical.filter(n => n.delay > 0).length;
            if (elBadgeAiCount) elBadgeAiCount.textContent = aiValid || aiPhysical.length;

            // 3. 回显：游戏模式
            const gameState = state.speedtest.game || {};
            elNodeGameReal.textContent = game.realNode || '--';
            elNodeGameDelay.textContent = game.delay > 0 ? `${game.delay} ms` : '-- ms';
            elNodeGameDelay.className = `${getDelayClass(game.delay)}`;
            if (elNodeGameLoss) {
                const lossNum = gameState.lastLoss;
                const lossPct = lossNum > 0 ? (lossNum * 100).toFixed(0) + '%' : (lossNum === 0 ? '0%' : '--%');
                elNodeGameLoss.innerHTML = '';
                const pctSpan = document.createElement('span');
                pctSpan.textContent = lossPct + ' ';
                pctSpan.className = lossNum === 0 ? 'text-green' : lossNum <= 0.2 ? 'text-orange' : 'text-red';
                const labelSpan = document.createElement('span');
                labelSpan.textContent = '丢包';
                labelSpan.style.cssText = 'font-size:10px; color: var(--text-secondary);';
                elNodeGameLoss.appendChild(pctSpan);
                elNodeGameLoss.appendChild(labelSpan);
                elNodeGameLoss.style.fontSize = '';
            }
            lastSelectedGameNode = game.realNode || game.now || '';
            const gamePhysical = (game.all || []).filter(n => n && n.name && !groupKeywords.some(k => n.name.includes(k)));
            const gameValid = gamePhysical.filter(n => n.delay > 0).length;
            if (elBadgeGameCount) elBadgeGameCount.textContent = gameValid || gamePhysical.length;

            // 4. 动态渲染游戏节点下拉菜单（仅物理节点，排除 Selector/URLTest）
            elGameDropdownListContainer.innerHTML = '';
            const allCandidates = [];
            const perNodeResults = gameState.perNodeResults || [];
            (game.all || []).forEach(node => {
                if (node && node.name) {
                    const isGroup = groupKeywords.some(k => node.name.includes(k));
                    if (!isGroup) {
                        allCandidates.push({ name: node.name, delay: node.delay || 0, displayName: node.name });
                    }
                }
            });

            // 如果当前 now 节点不在备选里，为防空白添加临时选项
            const existInCandidates = allCandidates.some(c => c.name === lastSelectedGameNode);
            if (lastSelectedGameNode && lastSelectedGameNode !== 'DIRECT' && lastSelectedGameNode !== 'GLOBAL' && !existInCandidates) {
                allCandidates.push({
                    name: lastSelectedGameNode,
                    delay: game.delay || 0,
                    displayName: lastSelectedGameNode
                });
            }

            // Sort by delay ascending (0-delay nodes at bottom)
            allCandidates.sort((a, b) => {
                if (a.delay <= 0 && b.delay <= 0) return 0;
                if (a.delay <= 0) return 1;
                if (b.delay <= 0) return -1;
                return a.delay - b.delay;
            });

            // 循环添加节点项
            allCandidates.forEach(cand => {
                const isSelected = cand.name === lastSelectedGameNode;
                
                const itemDiv = document.createElement('div');
                itemDiv.className = `game-dropdown-item${isSelected ? ' selected' : ''}`;
                
                const leftDiv = document.createElement('div');
                leftDiv.className = 'game-dropdown-item-left';
                if (isSelected) {
                    leftDiv.innerHTML = `<span class="material-symbols-outlined icon-selected-check">check_circle</span>`;
                } else {
                    leftDiv.innerHTML = `<span class="icon-placeholder"></span>`;
                }
                const nameSpan = document.createElement('span');
                nameSpan.className = 'game-dropdown-item-name';
                nameSpan.textContent = cand.displayName;
                leftDiv.appendChild(nameSpan);
                itemDiv.appendChild(leftDiv);
                
                const rightDiv = document.createElement('span');
                rightDiv.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;';
                const nodeResult = perNodeResults.find(r => r.name === cand.name);
                const hasLoss = nodeResult && nodeResult.loss !== undefined;
                if (hasLoss) {
                    const lNum = nodeResult.loss;
                    const lPct = lNum > 0 ? (lNum * 100).toFixed(0) + '%' : '0%';
                    const lossColor = lNum === 0 ? 'text-green' : lNum <= 0.2 ? 'text-orange' : 'text-red';
                    const pctSpan = document.createElement('span');
                    pctSpan.textContent = lPct; pctSpan.className = lossColor;
                    const unitSpan = document.createElement('span');
                    unitSpan.textContent = '丢包'; unitSpan.style.cssText = 'font-size:10px;color:var(--text-secondary);';
                    const delaySpan = document.createElement('span');
                    delaySpan.textContent = cand.delay > 0 ? cand.delay + 'ms' : '--';
                    delaySpan.className = getDelayClass(cand.delay);
                    rightDiv.appendChild(pctSpan); rightDiv.appendChild(unitSpan); rightDiv.appendChild(delaySpan);
                } else if (cand.delay > 0) {
                    rightDiv.textContent = cand.delay + ' ms';
                    rightDiv.className = getDelayClass(cand.delay) + ' flex-shrink-0';
                } else {
                    rightDiv.textContent = '--';
                    rightDiv.className = 'text-muted flex-shrink-0';
                }
                itemDiv.appendChild(rightDiv);
                
                itemDiv.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (cand.name === lastSelectedGameNode) { closeGameDropdown(); return; }
                    await handleGameNodeSelect(cand.name);
                });
                
                elGameDropdownListContainer.appendChild(itemDiv);
            });

            // 5. 动态渲染 AI 节点下拉菜单
            elAiDropdownListContainer.innerHTML = '';
            let lastSelectedAiNode = ai.realNode || ai.now || '';

            const aiCandidates = [];
            const aiPhysicalNodes = ai.all || [];
            aiPhysicalNodes.forEach(node => {
                if (node && node.name) {
                    const lower = node.name.toLowerCase();
                    const isGroup = groupKeywords.some(k => lower.includes(k.toLowerCase()));
                    const isHK = hkKeywords.some(k => lower.includes(k));
                    if (!isGroup && !isHK) {
                        aiCandidates.push({ name: node.name, delay: node.delay || 0, displayName: node.name });
                    }
                }
            });

            // 如果当前 now 节点不在备选里，为防空白添加临时选项
            const aiExistInCandidates = aiCandidates.some(c => c.name === lastSelectedAiNode);
            if (lastSelectedAiNode && lastSelectedAiNode !== 'DIRECT' && lastSelectedAiNode !== 'GLOBAL' && !aiExistInCandidates) {
                aiCandidates.push({
                    name: lastSelectedAiNode,
                    delay: ai.delay || 0,
                    displayName: lastSelectedAiNode
                });
            }

            aiCandidates.sort((a, b) => {
                if (a.delay <= 0 && b.delay <= 0) return 0;
                if (a.delay <= 0) return 1;
                if (b.delay <= 0) return -1;
                return a.delay - b.delay;
            });

            // 渲染 AI 下拉列表
            aiCandidates.forEach(cand => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'game-dropdown-item';
                if (cand.name === lastSelectedAiNode) {
                    itemDiv.classList.add('selected');
                }

                const leftDiv = document.createElement('div');
                leftDiv.className = 'game-dropdown-item-left';

                if (cand.name === lastSelectedAiNode) {
                    leftDiv.innerHTML = `<span class="material-symbols-outlined icon-selected-check">check_circle</span>`;
                } else {
                    leftDiv.innerHTML = `<span class="icon-placeholder"></span>`;
                }

                const nameSpan = document.createElement('span');
                nameSpan.className = 'game-dropdown-item-name';
                nameSpan.textContent = cand.displayName;
                leftDiv.appendChild(nameSpan);
                itemDiv.appendChild(leftDiv);

                // 右侧延迟元素
                const rightSpan = document.createElement('span');
                if (cand.delay > 0) {
                    rightSpan.textContent = `${cand.delay} ms`;
                    rightSpan.className = getDelayClass(cand.delay) + ' flex-shrink-0';
                } else {
                    rightSpan.textContent = '--';
                    rightSpan.className = 'text-muted flex-shrink-0';
                }
                itemDiv.appendChild(rightSpan);

                // 绑定点击切换事件
                itemDiv.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (cand.name === lastSelectedAiNode) {
                        closeAiDropdown();
                        return;
                    }
                    await handleAiNodeSelect(cand.name);
                });

                elAiDropdownListContainer.appendChild(itemDiv);
            });

            // 6. 动态渲染代理节点下拉菜单
            let lastSelectedProxyNode = proxy.realNode || proxy.now || '';

            function renderProxyDropdownList(proxyData) {
                elProxyDropdownListContainer.innerHTML = '';
                const proxyCandidates = [];
                const groupKeywords = ['选择', '自动', 'DIRECT', 'GLOBAL', '测速'];
                const proxyPhysicalNodes = proxyData.all || [];
                proxyPhysicalNodes.forEach(node => {
                    if (node && node.name) {
                        const lower = node.name.toLowerCase();
                        const isGroup = groupKeywords.some(k => lower.includes(k.toLowerCase()));
                        if (!isGroup) {
                            proxyCandidates.push({ name: node.name, delay: node.delay || 0, displayName: node.name });
                        }
                    }
                });

                // 如果当前 now 节点不在备选里，为防空白添加临时选项
                const proxyExistInCandidates = proxyCandidates.some(c => c.name === lastSelectedProxyNode);
                if (lastSelectedProxyNode && lastSelectedProxyNode !== 'DIRECT' && lastSelectedProxyNode !== 'GLOBAL' && !proxyExistInCandidates) {
                    proxyCandidates.push({
                        name: lastSelectedProxyNode,
                        delay: proxyData.delay || 0,
                        displayName: lastSelectedProxyNode
                    });
                }

                proxyCandidates.sort((a, b) => {
                    if (a.delay <= 0 && b.delay <= 0) return 0;
                    if (a.delay <= 0) return 1;
                    if (b.delay <= 0) return -1;
                    return a.delay - b.delay;
                });

                // 渲染代理下拉列表
                proxyCandidates.forEach(cand => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'game-dropdown-item';
                    if (cand.name === lastSelectedProxyNode) {
                        itemDiv.classList.add('selected');
                    }

                    const leftDiv = document.createElement('div');
                    leftDiv.className = 'game-dropdown-item-left';

                    if (cand.name === lastSelectedProxyNode) {
                        leftDiv.innerHTML = `<span class="material-symbols-outlined icon-selected-check">check_circle</span>`;
                    } else {
                        leftDiv.innerHTML = `<span class="icon-placeholder"></span>`;
                    }

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'game-dropdown-item-name';
                    nameSpan.textContent = cand.displayName;
                    leftDiv.appendChild(nameSpan);
                    itemDiv.appendChild(leftDiv);

                    // 右侧延迟元素
                    const rightSpan = document.createElement('span');
                    if (cand.delay > 0) {
                        rightSpan.textContent = `${cand.delay} ms`;
                        rightSpan.className = getDelayClass(cand.delay) + ' flex-shrink-0';
                    } else {
                        rightSpan.textContent = '--';
                        rightSpan.className = 'text-muted flex-shrink-0';
                    }
                    itemDiv.appendChild(rightSpan);

                    // 绑定点击切换事件
                    itemDiv.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (cand.name === lastSelectedProxyNode) {
                            closeProxyDropdown();
                            return;
                        }
                        await handleProxyNodeSelect(cand.name);
                    });

                    elProxyDropdownListContainer.appendChild(itemDiv);
                });

                // 如果后端标明还有更多节点可用，在下拉框底部显示“展开全部节点...”按钮
                if (proxyData.hasMore) {
                    const moreDiv = document.createElement('div');
                    moreDiv.className = 'game-dropdown-item show-more-nodes';
                    moreDiv.style.justifyContent = 'center';
                    moreDiv.style.color = '#ffb786';
                    moreDiv.style.cursor = 'pointer';
                    moreDiv.style.fontWeight = '500';
                    moreDiv.innerHTML = '<span>展开全部节点...</span>';
                    moreDiv.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        moreDiv.innerHTML = '<span>正在加载全部...</span>';
                        try {
                            const res = await fetch('/api/nodes?all=true');
                            if (!res.ok) throw new Error('加载失败');
                            const data = await res.json();
                            if (data.status === 'success' && data.proxies) {
                                renderProxyDropdownList(data.proxies.proxy || {});
                            }
                        } catch (err) {
                            moreDiv.innerHTML = '<span style="color: #ff6432;">加载失败，请重试</span>';
                        }
                    });
                    elProxyDropdownListContainer.appendChild(moreDiv);
                }
            }

            renderProxyDropdownList(proxy);

            // 显示 Modal 弹窗
            elNodeDetailModal.classList.add('active');

        } catch (err) {
            console.error('节点详情加载失败:', err);
            showToast('获取节点详情失败: ' + err.message);
        } finally {
            hideLoading();
        }
    }

    // 核心切换请求逻辑
     async function handleGameNodeSelect(newVal) {
        // 关闭下拉框
        closeGameDropdown();
        // 发送节点切换请求
        showLoading('正在切换游戏节点...');
        try {
            const res = await fetch('/api/select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group: '🎮 游戏加速', node: newVal })
            });

            if (!res.ok) throw new Error('接口响应错误');
            const data = await res.json();
            if (data.status === 'success') {
                showToast('已成功切换游戏节点！');
                await openNodeDetailModal(true);
                await fetchStatus();
            } else {
                throw new Error(data.message || '切换失败');
            }
        } catch (err) {
            showToast('切换节点失败: ' + err.message);
        } finally {
            hideLoading();
        }
    }

    // AI 强化模式节点切换逻辑
    async function handleAiNodeSelect(newVal) {
        // 关闭下拉框
        closeAiDropdown();
        // 发送节点切换请求
        showLoading('正在切换 AI 强化节点...');
        try {
            const res = await fetch('/api/select', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    group: '🤖 AI强化',
                    node: newVal
                })
            });

            if (!res.ok) throw new Error('接口响应错误');
            const data = await res.json();
            if (data.status === 'success') {
                showToast('已成功切换 AI 强化节点！');
                await openNodeDetailModal(true);
                await fetchStatus();
            } else {
                throw new Error(data.message || '切换失败');
            }
        } catch (err) {
            showToast('切换节点失败: ' + err.message);
        } finally {
            hideLoading();
        }
    }

    // 代理模式节点切换逻辑
    async function handleProxyNodeSelect(newVal) {
        // 关闭下拉框
        closeProxyDropdown();
        // 发送节点切换请求
        showLoading('正在切换代理节点...');
        try {
            const res = await fetch('/api/select', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    group: '🚀 节点选择',
                    node: newVal
                })
            });

            if (!res.ok) throw new Error('接口响应错误');
            const data = await res.json();
            if (data.status === 'success') {
                showToast('已成功切换代理节点！');
                await openNodeDetailModal(true);
                await fetchStatus();
            } else {
                throw new Error(data.message || '切换失败');
            }
        } catch (err) {
            showToast('切换节点失败: ' + err.message);
        } finally {
            hideLoading();
        }
    }

    // 绑定事件：点击”当前节点”卡片触发详情弹窗
    const elNodeStatusCard = document.getElementById('node-status-card');
    if (elNodeStatusCard) {
        elNodeStatusCard.addEventListener('click', (e) => {
            e.preventDefault();
            if (state.isRebuilding) {
                showToast('策略重载中，暂无法切换节点');
                return;
            }
            openNodeDetailModal();
        });
    }

    // 绑定事件：展开/折叠游戏节点下拉选单触发区
    if (elBtnToggleGameDropdown) {
        elBtnToggleGameDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGameDropdown();
        });
    }

    // 绑定事件：展开/折叠 AI 节点下拉选单触发区
    if (elBtnToggleAiDropdown) {
        elBtnToggleAiDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleAiDropdown();
        });
    }

    // 绑定事件：展开/折叠代理节点下拉选单触发区
    if (elBtnToggleProxyDropdown) {
        elBtnToggleProxyDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleProxyDropdown();
        });
    }

    // 绑定事件：点击文档其它任意位置时自动折叠下拉框
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#btn-toggle-game-dropdown') && !e.target.closest('#game-node-dropdown-menu')) {
            if (elGameNodeDropdownMenu && elGameNodeDropdownMenu.style.display !== 'none') {
                closeGameDropdown();
            }
        }
        if (!e.target.closest('#btn-toggle-ai-dropdown') && !e.target.closest('#ai-node-dropdown-menu')) {
            if (elAiNodeDropdownMenu && elAiNodeDropdownMenu.style.display !== 'none') {
                closeAiDropdown();
            }
        }
        if (!e.target.closest('#btn-toggle-proxy-dropdown') && !e.target.closest('#proxy-node-dropdown-menu')) {
            if (elProxyNodeDropdownMenu && elProxyNodeDropdownMenu.style.display !== 'none') {
                closeProxyDropdown();
            }
        }
    });

    // 绑定事件：关闭节点详情弹窗（同步关闭外部下拉菜单）
    elBtnCloseNodeModal.addEventListener('click', () => {
        closeGameDropdown();
        closeAiDropdown();
        closeProxyDropdown();
        elNodeDetailModal.classList.remove('active');
    });
    if (elBtnCloseNodeModalOk) {
        elBtnCloseNodeModalOk.addEventListener('click', () => {
            closeGameDropdown();
            closeAiDropdown();
            closeProxyDropdown();
            elNodeDetailModal.classList.remove('active');
        });
    }


    // 绑定事件：点击“错误日志”文字链（事件委托）
    elStatusMode.addEventListener('click', async (e) => {
        const link = e.target.closest('#view-error-log');
        if (!link) return;

        showLoading('正在获取路由器错误日志，请稍候...');
        try {
            const res = await fetch('/api/error-log');
            if (!res.ok) throw new Error();
            const data = await res.json();
            
            // 格式化展示最近的退出日志，若日志为空则显示无报错
            elErrorLogContent.value = data.log || '没有在路由器上找到相关的异常退出错误记录。';
            elErrorLogModal.classList.add('active');
        } catch (err) {
            elErrorLogContent.value = '无法从路由器获取日志数据，请检查 SSH 密码与接口通信状态。\n错误信息: ' + err.message;
            elErrorLogModal.classList.add('active');
        } finally {
            hideLoading();
        }
    });

    // 绑定事件：关闭错误日志弹窗
    elBtnCloseLogModal.addEventListener('click', () => {
        elErrorLogModal.classList.remove('active');
    });
    elBtnCloseLogModalOk.addEventListener('click', () => {
        elErrorLogModal.classList.remove('active');
    });

    // 定时器：每 10 秒拉取一次真实的设备流量和状态，并重绘 (H2: 降低 DOM 重建频率)
    setInterval(() => {
        fetchDevices();
    }, 10000);

    // 定时器：每 15 秒更新一次真实的 Clash 核心状态
    setInterval(() => {
        fetchStatus();
    }, 15000);

    // 页面初始化
    async function init() {
        showLoading('正在加载设备列表与服务状态...');
        
        elFooterUptime.textContent = formatUptime(state.systemUptimeMinutes);
        
        // Lock badge click handlers
        if (elBadgeGameLock) elBadgeGameLock.addEventListener('click', () => toggleLock('game'));
        if (elBadgeAiLock) elBadgeAiLock.addEventListener('click', () => toggleLock('ai'));
        
        await fetchStatus();
        await fetchDevices();
        await fetchSpeedtestStatus();
        
        updateRealSpeeds();
        renderFilterTabs();
        renderGrid();
        
        hideLoading();
    }

    // 定时器：每 30 秒同步测速状态
    setInterval(() => {
        fetchSpeedtestStatus();
    }, 30000);

    init();
});
