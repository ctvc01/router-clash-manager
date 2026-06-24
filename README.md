# Router Clash Manager — Clash Meta 透明代理控制系统

基于 NAS 容器的 Clash Meta 代理管理系统，通过 iptables MAC 劫持实现对局域网设备的透明代理，支持 AI 强化、游戏加速等多种模式。

## 架构

```
路由器 (192.168.31.1, OpenWrt, MIPS 4.4.60)
├─ iptables REDIRECT TCP → Clash Meta (Mihomo v1.19.27)
├─ iptables REJECT UDP 443 → 强制 QUIC → TCP 回退
├─ s-s-r / Trojan 出口节点（IPLC / gRPC / Reality）
└─ /data/ShellCrash/configs/mac — 设备白名单

NAS 容器 (191.168.31.66:3000)
├─ Web 管理界面（状态监控、设备管理、节点切换）
├─ SSH 隧道 → 路由器 Clash API (:9999)
├─ GameAccService — 游戏节点 5 采祥丢包+延迟测速
├─ AIBoostService — AI 节点单采祥延迟测速（HK 过滤）
├─ RulesEngine — Clash 配置规则注入（AI 域名 / Nintendo 域名 / 代理组）
├─ SpeedtestState — 测速结果持久化与 LOCK/UNLOCK 状态管理
└─ SystemValidator — 设备 3 次检查确认后才清理

用户设备（192.168.31.x）
├─ 普通模式 → TCP 透明代理 → 全局自动节点
├─ AI 强化 → TCP 透明代理（IPLC 节点池，排除 HK）
└─ 游戏加速 → TCP 透明代理（日韩台节点池，Nintendo CDN 测速）
```

## 核心功能

### 透明代理（iptables REDIRECT）
- `TCP:7892` — REDIRECT 劫持白名单设备的 TCP 流量
- `UDP:1053` — DNS 监听（可选）
- `UDP 443 REJECT` — 阻断 QUIC，强制浏览器回退 TCP
- `forwarding_rule` 链 — OpenWrt 自定义转发规则

### 智能节点选择
| 模式 | 节点池 | 测速 URL | 策略 |
|------|--------|---------|------|
| 通用代理 | 全球 ~60 gRPC 节点 | gstatic.com | URLTest 自动选最优 |
| AI 强化 | ~17 IPLC 中继节点（过滤 HK） | generativeai.googleapis.com | 单采祥延迟排序 |
| 游戏加速 | ~20 日韩台节点 | Nintendo CDN | 5 采祥丢包→延迟加权排序 |

### 持久化状态
- 设备列表 → `/data/ai_devices` / `/data/game_devices`
- 测速结果 → `/data/speedtest_state.json`
- 白名单 → 路由器 `/data/ShellCrash/configs/mac`
- 配置备份 → `/data/configs_backup/`

## 快速部署

```yaml
# docker-compose.yml
services:
  clash-meta:
    build: .
    container_name: clash-meta
    network_mode: "host"
    restart: always
    environment:
      - ROUTER_IP=192.168.31.1
      - ROUTER_USER=root
      - ROUTER_PASSWORD=xxx
      - NODE_ENV=production
      - PORT=3000
    volumes:
      - ./device_custom.json:/data/device_custom.json
      - ./game_devices:/data/game_devices
      - ./ai_devices:/data/ai_devices
      - ./aliases.json:/data/aliases.json
      - ./speedtest_state.json:/data/speedtest_state.json
      - ./validator_pending.json:/data/validator_pending.json
      - ./logs:/data/logs
      - ./Clash:/data/clash_backup/Clash
      - ./Country.mmdb:/data/clash_backup/Country.mmdb
      - ./configs_backup:/data/configs_backup
      - ./config_versions:/data/config_versions
```

```bash
docker compose up -d --build
```

## 项目结构

```
src/
├── server.js               # 启动入口：设备同步、规则注入、守护进程
├── app.js                  # Express 路由挂载
├── config.js               # 配置管理
├── services/
│   ├── rulesEngine.js      # Clash 配置规则/代理组注入引擎
│   ├── gameAccService.js   # 游戏加速：5 采祥丢包+延迟测速、节点锁定
│   ├── aiBoostService.js   # AI 强化：单采祥延迟测速、HK 过滤
│   ├── accelerationService.js # 启用/禁用加速（统一入口）
│   ├── sshService.js        # SSH 远程命令执行与文件传输
│   ├── clashService.js      # Clash HTTP API 通信（带 10s 缓存）
│   ├── speedtestState.js    # 测速状态持久化与 LOCK/UNLOCK
│   └── systemValidator.js   # 启动完整性验证
├── routes/
│   ├── gateway.js           # /api/status, /api/nodes, /api/select
│   ├── devices.js           # /api/devices 设备发现与分组
│   ├── ai.js / game.js      # AI/Game 模式开关
│   ├── speedtest.js         # /api/speedtest 测速状态与锁
│   └── whitelist.js         # MAC 白名单管理
├── utils/
│   ├── clashApiProxy.js     # Clash API 代理（带 SSH 隧道 + 10s 缓存）
│   └── proxyGroupDetector.js # 代理组链解析器
scripts/
├── setup_iptables.sh        # iptables TCP REDIRECT 重建设
├── setup_quic_block.sh      # UDP 443 QUIC 阻断
└── check_modes.sh           # 四模式连通性检测工具
public/
├── index.html               # 前端页面
├── app.js                   # 前端逻辑
└── style.css                # 样式
```

## Web UI

| 卡片 | 说明 |
|------|------|
| 网关状态 | Clash 进程运行状态 + 启动时长 |
| 当前节点 | 当前代理物理节点 + 延迟 |
| 设备状态 | 代理设备数/全部设备数 + 模式分布进度条 |
| 磁盘占用 | /data 分区磁盘用量 |

节点详情弹窗支持：
- 三模式独立节点池
- 实时延迟/丢包数据（游戏模式）
- LOCK/UNLOCK 一键锁定（不触发测速）
- 延迟排序下拉选择

## 许可

MIT
