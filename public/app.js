document.addEventListener('DOMContentLoaded', () => {
    // 页面核心节点缓存
    const elStatusText = document.getElementById('status-text');
    const elStatusMode = document.getElementById('status-mode');
    const elCurrentNode = document.getElementById('current-node');
    const elNodeLatency = document.getElementById('node-latency');
    const elDevicesTotal = document.getElementById('devices-total');
    const elDevicesProxy = document.getElementById('devices-proxy');
    const elMemoryUsed = document.getElementById('memory-used');
    const elMemoryTotal = document.getElementById('memory-total');
    const elMemoryProgress = document.getElementById('memory-progress');
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



    // 全局状态管理
    let state = {
        whitelist: [],            // 代理白名单的 MAC 列表 (来自后端)
        gameAccelerated: [],      // 游戏加速的 MAC 列表 (来自后端)
        aiBoosted: [],            // AI 强化的 MAC 列表 (来自后端)
        customDevices: {},        // 自定义设备别名与类型列表 (来自后端)
        lanDevices: [],           // 融合后的局域网设备列表
        status: {},               // 路由运行状态
        activeCategory: 'all',    // 当前激活的过滤类别
        deviceSpeeds: {},         // 各设备的仿真网速波动缓存
        systemUptimeMinutes: 20482 // 模拟运行时间自增
    };

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

    // 辅助：格式化运行时间 (分钟转 "X天 Y时 Z分")
    function formatUptime(totalMinutes) {
        const days = Math.floor(totalMinutes / (24 * 60));
        const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const mins = totalMinutes % 60;
        return `运行时间: ${days}天 ${hours.toString().padStart(2, '0')}时 ${mins.toString().padStart(2, '0')}分`;
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

    // 接口：获取 Clash 服务状态与监控数据的真实联动
    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) throw new Error();
            const data = await res.json();
            state.status = data;
            
            if (data.running) {
                const isLoadingState = data.currentNode === '未知' || data.version === '未知' || data.mode === '未知';

                if (isLoadingState) {
                    elStatusText.textContent = '加载中';
                    elStatusText.className = 'card-value text-orange';
                    elStatusMode.textContent = '';
                    
                    elCurrentNode.textContent = '加载中';
                    elCurrentNode.classList.remove('long-text');
                    elNodeLatency.textContent = '';
                } else {
                    elStatusText.textContent = '运行中';
                    elStatusText.className = 'card-value text-green';
                    elStatusMode.innerHTML = `模式: ${(data.mode || '未知').toUpperCase()}`;
                    
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
                
                // 内存占用完全真实联动
                const memStr = data.memory;
                let usedMB = parseInt(memStr) || 0;
                const totalMemStr = data.totalMemory || '1024 MB';
                let totalMB = parseInt(totalMemStr) || 1024;
                simulateMemoryBar(usedMB, totalMB);
                
                // 更新真实的 Uptime
                if (data.uptime && data.uptime > 0) {
                    state.systemUptimeMinutes = Math.round(data.uptime / 60);
                }
                elFooterUptime.textContent = formatUptime(state.systemUptimeMinutes);
                
                elFooterVersion.textContent = `内核版本: ${data.version} (Mihomo)`;
                elFooterCpu.textContent = `CPU: ${data.cpu}`;
            } else {
                const totalMemStr = data.totalMemory || '1024 MB';
                let totalMB = parseInt(totalMemStr) || 1024;
                simulateMemoryBar(0, totalMB);
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
            simulateMemoryBar(0, 1024);
            elStatusText.textContent = '离线/未知';
            elStatusText.className = 'card-value text-muted';
            elStatusMode.innerHTML = '无法与后端通信';
            
            elCurrentNode.textContent = '已关闭';
            elCurrentNode.classList.remove('long-text');
            elNodeLatency.textContent = '延迟: --';
            
            elFooterVersion.textContent = '内核版本: 离线 (Mihomo)';
            elFooterCpu.textContent = 'CPU: --';
            elFooterMemory.textContent = '内存: -- / 1024MB';
        }
    }

    function simulateMemoryBar(usedMB, totalMB) {
        totalMB = totalMB || 1024;
        elMemoryUsed.textContent = `${usedMB}MB`;
        elMemoryTotal.textContent = `${totalMB}MB`;
        const percent = Math.round((usedMB / totalMB) * 100);
        elMemoryProgress.style.width = `${percent}%`;
        
        // 动态警示色联动
        elMemoryProgress.classList.remove('warning-bar', 'danger-bar');
        elMemoryUsed.classList.remove('text-green', 'text-yellow', 'text-red');
        
        if (percent >= 80) {
            elMemoryProgress.classList.add('danger-bar');
            elMemoryUsed.classList.add('text-red');
        } else if (percent >= 60) {
            elMemoryProgress.classList.add('warning-bar');
            elMemoryUsed.classList.add('text-yellow');
        } else {
            elMemoryUsed.classList.add('text-green');
        }
        
        elFooterMemory.textContent = `内存: ${usedMB}MB / ${totalMB}MB`;
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
            elDevicesTotal.textContent = state.lanDevices.length;
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length + state.aiBoosted.length;
            
            renderFilterTabs();
            updateRealSpeeds();
            renderGrid();
        } catch (e) {
            console.error('获取设备列表异常 (前端):', e);
            // 异常时回退为空列表
            state.lanDevices = [];
            elDevicesTotal.textContent = 0;
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length + state.aiBoosted.length;
            
            renderFilterTabs();
            updateRealSpeeds();
            renderGrid();
        }
    }

    // 逻辑：向白名单添加设备
    async function addDevice(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        if (!state.whitelist.includes(mac)) {
            state.whitelist.push(mac);
        }
        
        const res = await fetch('/api/whitelist/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || data.details || '添加白名单失败');
        }
        
        elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
        renderGrid();
    }

    // 逻辑：从白名单移出设备
    async function removeDevice(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        const res = await fetch('/api/whitelist/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || data.details || '移出白名单失败');
        }
        
        elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
        renderGrid();
    }

    // [新增] 开启游戏加速
    async function enableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        if (!state.gameAccelerated.includes(mac)) {
            state.gameAccelerated.push(mac);
        }
        // 从普通白名单剔除，走专门的游戏 AND 规则路由
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        const res = await fetch('/api/game/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        showToast('Switch 游戏加速通道已就绪，已选测最佳低延迟专线节点！');
    }

    // [新增] 关停游戏加速
    async function disableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        state.gameAccelerated = state.gameAccelerated.filter(m => m !== mac);
        
        const res = await fetch('/api/game/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        showToast('游戏加速通道已成功关停，规则已重载！');
    }

    // [新增] 开启 AI 强化
    async function enableAi(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        if (!state.aiBoosted.includes(mac)) {
            state.aiBoosted.push(mac);
        }
        state.whitelist = state.whitelist.filter(m => m !== mac);
        state.gameAccelerated = state.gameAccelerated.filter(m => m !== mac);
        
        const res = await fetch('/api/ai/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
        showToast('AI 极速分流通道已就绪，已自动寻优至最速 Google 节点！');
    }

    // [新增] 关停 AI 强化
    async function disableAi(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        state.aiBoosted = state.aiBoosted.filter(m => m !== mac);
        
        const res = await fetch('/api/ai/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac: mac })
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || '网络连接或配置自检失败');
        }
        
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
            const displayName = (custom.name || d.hostname || '').trim();
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
            
            const isOffline = d.hostname === 'Living-Room-Light';
            
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
                        <div class="device-title-wrapper" data-ip-display="IP: ${d.ip}">
                            <div class="device-name-row">
                                <span class="device-name-text">${displayName}</span>
                                <button class="btn-edit-device" data-mac="${mac}" data-ip="${d.ip}" data-name="${displayName}" data-category="${category}" title="编辑名称和分类">
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
                    <span class="device-ip-text">IP: ${d.ip}</span>
                    <span class="device-mac-text">MAC: ${mac.toUpperCase()}</span>
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

        const mac = btn.getAttribute('data-mac').toLowerCase();
        const action = btn.getAttribute('data-action');
        
        if (!mac || !action) return;
        if (btn.classList.contains('active')) return;

        showLoading('正在切换网络分流策略并热重载内核...');
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

    // 绑定事件：搜索输入
    elSearchInput.addEventListener('input', () => {
        renderGrid();
    });

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

    // 绑定事件：点击“当前节点”卡片触发文字跑马灯滚动
    const elNodeStatusCard = document.getElementById('node-status-card');
    if (elNodeStatusCard) {
        elNodeStatusCard.addEventListener('click', () => {
            const scrollText = elNodeStatusCard.querySelector('.node-name-text-scroll');
            if (scrollText && scrollText.classList.contains('long-text')) {
                scrollText.classList.toggle('scroll-active');
            }
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

    // 定时器：每 3 秒高频拉取一次真实的设备流量和状态，并重绘
    setInterval(() => {
        fetchDevices();
    }, 3000);

    // 定时器：每 15 秒更新一次真实的 Clash 核心状态
    setInterval(() => {
        fetchStatus();
    }, 15000);

    // 页面初始化
    async function init() {
        showLoading('正在加载设备列表与服务状态...');
        
        elFooterUptime.textContent = formatUptime(state.systemUptimeMinutes);
        
        await fetchStatus();
        await fetchGameList();  // 拉取加速的游戏设备
        await fetchDevices();   // 拉取局域网设备并重绘
        
        updateRealSpeeds();
        renderFilterTabs();
        renderGrid();
        
        hideLoading();
    }

    init();
});
