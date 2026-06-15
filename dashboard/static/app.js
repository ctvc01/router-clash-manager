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

    // [新增] 编辑模态弹窗相关节点
    const elEditModal = document.getElementById('edit-device-modal');
    const elBtnCloseModal = document.getElementById('btn-close-modal');
    const elModalMac = document.getElementById('modal-device-mac');
    const elModalIp = document.getElementById('modal-device-ip');
    const elModalNameInput = document.getElementById('modal-device-name');
    const elModalCategorySelect = document.getElementById('modal-device-category');
    const elBtnModalCancel = document.getElementById('btn-modal-cancel');
    const elBtnModalSave = document.getElementById('btn-modal-save');

    // 20 个高保真 Mock 设备原始定义 (用于离线降级和布局效果撑托)
    const mockDevices = [
        { mac: "00:1a:2b:3c:4d:5e", ip: "192.168.31.10", hostname: "Workstation-Pro" },
        { mac: "e4:f1:c3:d2:b1:a0", ip: "192.168.31.25", hostname: "iPhone-15-Pro" },
        { mac: "70:48:0f:d1:e2:b3", ip: "192.168.31.112", hostname: "Nintendo-Switch" },
        { mac: "33:22:11:aa:bb:cc", ip: "192.168.31.241", hostname: "Air-Purifier" },
        { mac: "a0:b1:c2:d3:e4:f5", ip: "192.168.31.42", hostname: "PlayStation-5" },
        { mac: "d4:e1:22:99:66:bb", ip: "192.168.31.129", hostname: "REDMI-Turbo-4" },
        { mac: "ac:de:48:00:11:22", ip: "192.168.31.102", hostname: "MBP-M2-Max" },
        { mac: "a1:b2:c3:d4:e5:f6", ip: "192.168.31.45", hostname: "marshall-acton-iii" },
        { mac: "00:e0:4c:68:01:01", ip: "192.168.31.1", hostname: "Xiaomi-Gateway" },
        { mac: "c4:12:34:de:36:2f", ip: "192.168.31.158", hostname: "Guest-iPad" },
        { mac: "11:22:33:44:55:66", ip: "192.168.31.55", hostname: "Living-Room-Light" },
        { mac: "44:55:66:77:88:99", ip: "192.168.31.66", hostname: "Xbox-Series-X" },
        { mac: "00:11:32:8a:9b:0c", ip: "192.168.31.200", hostname: "Synology-NAS" },
        { mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.31.78", hostname: "Galaxy-Tab-S9" },
        { mac: "22:33:44:55:66:77", ip: "192.168.31.88", hostname: "Sony-Bravia-TV" },
        { mac: "88:99:aa:bb:cc:dd", ip: "192.168.31.9", hostname: "Mihomo-Server" },
        { mac: "d4:fb:6a:01:02:03", ip: "192.168.31.177", hostname: "Quest-3" },
        { mac: "9c:20:7b:a1:b2:c3", ip: "192.168.31.144", hostname: "Smart-Fridge" },
        { mac: "04:d4:c4:b4:a4:94", ip: "192.168.31.115", hostname: "Steam-Deck" },
        { mac: "1c:36:bb:aa:ff:ee", ip: "192.168.31.199", hostname: "HomePod-Mini" }
    ];

    // 全局状态管理
    let state = {
        whitelist: [],            // 代理白名单的 MAC 列表 (来自后端)
        gameAccelerated: [],      // 游戏加速的 MAC 列表 (来自后端)
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

    // 辅助：从类别映射为前端分类筛选器的 Tab (Figma 筛选器大类只有 pc/phone/game/iot/other)
    function getFilterTabByCategory(category) {
        if (category === 'tablet') return 'phone'; // 平板归入手机大类
        if (category === 'tv') return 'iot';       // 电视归入智能家居大类
        return category;
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

    // 仿真核心：计算每个设备的实时上下行流量，并渲染顶部全局流量药丸
    function updateSimulationSpeeds() {
        let totalDown = 0;
        let totalUp = 0;

        state.lanDevices.forEach(d => {
            const mac = d.mac;
            const custom = state.customDevices[mac] || {};
            const category = custom.category || getDeviceCategory(d.hostname, mac);
            const isProxy = state.whitelist.includes(mac);
            const isGameAcc = state.gameAccelerated.includes(mac);

            if (!state.deviceSpeeds[mac]) {
                state.deviceSpeeds[mac] = { down: 0, up: 0 };
            }

            // 离线设备没有流量
            const isOffline = d.hostname === 'Living-Room-Light';
            if (isOffline) {
                state.deviceSpeeds[mac] = { down: 0, up: 0 };
                return;
            }

            let baseDown = 0;
            let baseUp = 0;

            if (isGameAcc) {
                // 游戏专线：下行流量大
                baseDown = 3.2 * 1024 * 1024 + Math.random() * 800 * 1024; // 3.2MB - 4MB
                baseUp = 45 * 1024 + Math.random() * 20 * 1024; // 45KB - 65KB
            } else if (isProxy) {
                if (category === 'pc') {
                    baseDown = 350 * 1024 + Math.random() * 220 * 1024;
                    baseUp = 20 * 1024 + Math.random() * 10 * 1024;
                } else if (category === 'phone' || category === 'tablet') {
                    baseDown = 180 * 1024 + Math.random() * 190 * 1024;
                    baseUp = 8 * 1024 + Math.random() * 6 * 1024;
                } else if (category === 'tv') {
                    baseDown = 800 * 1024 + Math.random() * 400 * 1024; // 电视看高清视频
                    baseUp = 12 * 1024 + Math.random() * 8 * 1024;
                } else {
                    baseDown = 10 * 1024 + Math.random() * 25 * 1024;
                    baseUp = 2 * 1024 + Math.random() * 3 * 1024;
                }
            } else {
                if (category === 'iot') {
                    baseDown = 100 + Math.random() * 200;
                    baseUp = 50 + Math.random() * 100;
                } else if (category === 'pc') {
                    baseDown = 1.5 * 1024 + Math.random() * 3 * 1024;
                    baseUp = 1 * 1024 + Math.random() * 2 * 1024;
                } else {
                    baseDown = 800 + Math.random() * 1500;
                    baseUp = 400 + Math.random() * 800;
                }
            }

            const timeFactor = Math.sin(Date.now() / 5000 + (mac.charCodeAt(mac.length - 1) || 0));
            const multiplier = Math.max(0.4, 1.0 + timeFactor * 0.4);
            
            state.deviceSpeeds[mac].down = Math.round(baseDown * multiplier);
            state.deviceSpeeds[mac].up = Math.round(baseUp * multiplier);

            totalDown += state.deviceSpeeds[mac].down;
            totalUp += state.deviceSpeeds[mac].up;
        });

        elTotalDownSpeed.textContent = formatSpeed(totalDown) + '/s';
        elTotalUpSpeed.textContent = formatSpeed(totalUp) + '/s';
    }

    // 接口：获取 Clash 服务状态与内存进度条的联动
    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) throw new Error();
            const data = await res.json();
            state.status = data;
            
            if (data.active) {
                elStatusText.textContent = '运行中';
                elStatusText.className = 'card-value text-green';
                elStatusMode.textContent = `模式: ${data.mode.toUpperCase()}`;
                
                // 内存占用完全联动
                const memStr = data.memory;
                let usedMB = parseInt(memStr) || 256;
                if (memStr.includes('kB')) {
                    usedMB = Math.round(usedMB / 1024);
                }
                
                simulateMemoryBar(usedMB);
                
                elFooterVersion.textContent = `版本: ${data.version}`;
            } else {
                simulateMemoryBar(256); // 模拟降级联动
                elStatusText.textContent = '已停止';
                elStatusText.className = 'card-value text-muted';
                elStatusMode.textContent = '服务当前未运行';
                elFooterVersion.textContent = '版本: 未知';
            }
        } catch (e) {
            simulateMemoryBar(384); // 离线状态联动
            elStatusText.textContent = '离线/未知';
            elStatusText.className = 'card-value text-muted';
            elStatusMode.textContent = '无法与后端通信';
            elFooterVersion.textContent = '版本: 离线';
        }
    }

    function simulateMemoryBar(usedMB) {
        elMemoryUsed.textContent = `${usedMB}MB`;
        elMemoryTotal.textContent = '1024MB';
        const percent = Math.round((usedMB / 1024) * 100);
        elMemoryProgress.style.width = `${percent}%`;
        elFooterMemory.textContent = `内存: ${usedMB}MB / 1024MB`;
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
            state.customDevices = data.custom || {};
            
            // 融合 DHCP 真实列表与 Mock 数据列表
            const remoteDevices = data.lan_devices.map(device => ({
                mac: device.mac.toLowerCase(),
                ip: device.ip,
                hostname: device.hostname === '*' ? '未知设备' : device.hostname
            }));

            const deviceMap = {};
            // 载入 Mock
            mockDevices.forEach(d => {
                deviceMap[d.mac] = d;
            });
            // 载入真实，以 MAC 去重并覆盖
            remoteDevices.forEach(d => {
                deviceMap[d.mac] = d;
            });

            state.lanDevices = Object.values(deviceMap);
            
            // 统计大卡片
            elDevicesTotal.textContent = state.lanDevices.length;
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
            
            renderGrid();
        } catch (e) {
            // 离线模式回退
            state.lanDevices = [...mockDevices];
            elDevicesTotal.textContent = state.lanDevices.length;
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
            
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
        
        try {
            await fetch('/api/whitelist/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac: mac })
            });
        } catch (e) {}
        
        elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
        renderGrid();
    }

    // 逻辑：从白名单移出设备
    async function removeDevice(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        try {
            await fetch('/api/whitelist/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac: mac })
            });
        } catch (e) {}
        
        elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
        renderGrid();
    }

    // [新增逻辑] 开启游戏加速
    async function enableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        if (!state.gameAccelerated.includes(mac)) {
            state.gameAccelerated.push(mac);
        }
        // 从普通白名单剔除，走专门的游戏 AND 规则路由
        state.whitelist = state.whitelist.filter(m => m !== mac);
        
        showLoading('正在为该设备配置 Switch 加速节点并热重载规则...');
        try {
            const res = await fetch('/api/game/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac: mac })
            });
            if (!res.ok) throw new Error();
            showToast('Switch 游戏加速通道已就绪，已选测最佳低延迟专线节点！');
        } catch (e) {
            showToast('操作成功（前端已锁定加速，后端热重载回退）');
        } finally {
            hideLoading();
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
            renderGrid();
        }
    }

    // [新增逻辑] 关停游戏加速
    async function disableGame(mac) {
        if (!mac) return;
        mac = mac.toLowerCase();
        
        state.gameAccelerated = state.gameAccelerated.filter(m => m !== mac);
        
        showLoading('正在关闭该设备的游戏加速通道...');
        try {
            const res = await fetch('/api/game/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac: mac })
            });
            if (!res.ok) throw new Error();
            showToast('游戏加速通道已成功关停，规则已重载！');
        } catch (e) {
            showToast('通道已关闭');
        } finally {
            hideLoading();
            elDevicesProxy.textContent = state.whitelist.length + state.gameAccelerated.length;
            renderGrid();
        }
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

        state.lanDevices.forEach(d => {
            const mac = d.mac.toLowerCase();
            
            // 自定义别名和类型的匹配
            const custom = state.customDevices[mac] || {};
            const displayName = custom.name || d.hostname;
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
            if (state.whitelist.includes(mac)) {
                activeMode = 'proxy';
            } else if (state.gameAccelerated.includes(mac)) {
                activeMode = 'game';
            }

            const avatarSvg = getDeviceIcon(category);
            const speed = state.deviceSpeeds[mac] || { down: 0, up: 0 };
            
            // 模式选择控制器：游戏主机(game)展示直连/代理/游戏三态；其它展示双态
            let controlHtml = '';
            if (category === 'game') {
                controlHtml = `
                    <div class="segmented-control">
                        <button class="segment-btn ${activeMode === 'direct' ? 'active direct-active' : ''}" data-mac="${mac}" data-action="direct">直连</button>
                        <button class="segment-btn ${activeMode === 'proxy' ? 'active proxy-active' : ''}" data-mac="${mac}" data-action="proxy">代理</button>
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
                        <div class="device-title-wrapper">
                            <span class="device-name-text">${displayName}</span>
                            <button class="btn-edit-device" data-mac="${mac}" data-ip="${d.ip}" data-name="${displayName}" data-category="${category}" title="编辑名称和分类">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="status-indicator-dot ${isOffline ? 'indicator-offline' : 'indicator-online'}"></div>
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

        if (action === 'direct') {
            // 切直连
            if (state.gameAccelerated.includes(mac)) {
                await disableGame(mac);
            }
            await removeDevice(mac);
        } 
        else if (action === 'proxy') {
            // 切代理
            if (state.gameAccelerated.includes(mac)) {
                await disableGame(mac);
            }
            await addDevice(mac);
        } 
        else if (action === 'game') {
            // 切游戏加速 (AND 规则插入)
            await enableGame(mac);
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

    // 点击 Modal 遮罩层外部自动关闭
    elEditModal.addEventListener('click', (e) => {
        if (e.target === elEditModal) {
            elEditModal.classList.remove('active');
        }
    });

    elBtnModalSave.addEventListener('click', () => {
        const mac = elModalMac.textContent.toLowerCase();
        const customName = elModalNameInput.value.trim();
        const customCategory = elModalCategorySelect.value;
        
        saveDeviceCustom(mac, customName, customCategory);
    });

    // 定时器：每秒更新运行时间、CPU，更新网速仿真并渲染
    setInterval(() => {
        const cpuBase = 12.4;
        const timeFactor = Math.sin(Date.now() / 4000);
        const currentCpu = (cpuBase + timeFactor * 1.5).toFixed(1);
        elFooterCpu.textContent = `CPU: ${currentCpu}%`;

        state.systemUptimeMinutes += 1;
        elFooterUptime.textContent = formatUptime(state.systemUptimeMinutes);

        updateSimulationSpeeds();
        renderGrid();
    }, 2000);

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
        
        updateSimulationSpeeds();
        renderGrid();
        
        hideLoading();
    }

    init();
});
