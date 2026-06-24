# Clash Meta 🚀
> 家用路由器 Clash (Mihomo) 网页端设备分流与游戏加速管理器

<table align="center" border="0">
  <tr>
    <td align="center" valign="middle" style="border: none;">
      <img src="docs/images/mobile_preview.jpg" height="360" alt="Mobile Preview" />
    </td>
    <td align="center" valign="middle" style="border: none;">
      <img src="docs/images/web_preview.png" height="360" alt="Web Preview" />
    </td>
  </tr>
</table>

**Clash Meta** 是一款专为家用/软路由环境打造的 Clash (Mihomo) 辅助控制台。通过 NAS 容器部署，以 SSH 协议安全联动路由器上的 Clash Meta 内核，提供设备级透明代理、AI 强化分流和 Switch 游戏加速功能。

---

## 🎯 解决什么痛点？

* **🧑‍👩‍👧‍👦 多设备策略不统一**：手机要翻墙，电视要直连（否则国内 App 卡顿），Switch 需要游戏专线。Web UI 为每台设备一键分配独立策略，无需逐台配置。
* **🎮 Switch 联机掉线 / 商店打不开**：自动测速切换节点时出口 IP 突变，直接打断任天堂联机匹配。游戏模式提供节点**锁定功能**，配合 Nintendo CDN 独立域名规则，商店和下载全程走游戏专线不掉线。
* **🤖 AI 服务（Gemini/ChatGPT）访问不稳定**：香港 IP 被 Google AI 服务封禁，普通代理可能路由到香港出口导致无法访问。AI 强化模式排除香港节点，独立 IPLC 中继节点池保障稳定连接。
* **❌ YouTube 播放失败**：浏览器优先使用 QUIC (UDP 443) 绕过透明代理。本系统自劢阻断 QUIC 退回到 TCP + Clash SNI 嗅探，确保 443 端口 HTTPS 正常代理。
* **🔄 路由器重启后配置自愈**：Clash 内核、GeoIP 数据库、设备白名单、iptables 规则全自动恢复，无需手动干预。

---

## 🌟 核心功能

* **📱 设备自动发现与三态分流**：自动扫描 ARP+DCHP 的局域网在线设备，支持自定义别名。一键切换**直连/代理/AI 强化/游戏加速**四种状态。
* **🎮 游戏加速（Switch 优化）**：
  * 独立 **日本/韩国/台湾** 节点池，Nintendo CDN 实测选优。
  * 5 次多采样丢包+延迟测速，**丢包率优先**再比延迟。
  * LOCK/UNLOCK 锁定机制：锁定后不触发测速切换，永不掉线。
  * 注入 Nintendo CDN 域名规则（`atum.download.nintendo.net` 等），确保商店和下载走游戏节点。
* **🤖 AI 强化**：
  * 硬编码 OpenAI、Gemini、Claude、Google AI 等 28+ 域名规则。
  * 独立 IPLC 中继节点池（排除香港节点，避免 Gemini 不可用）。
  * 单次延迟测速，日常更新不产生额外丢包。
* **🧬 SNI 嗅探器 (Sniffer)**：Clash Meta 内置 TLS 连接嗅探，无需 geoip/geosite 数据库即可识别目标域名，REDIR 模式下 443 端口 HTTPS 正常连接。
* **🔒 设备锁定与状态持久化**：测速结果（delay/loss/perNodeResults）、锁定状态（LOCK/UNLOCK）持久化到 `speedtest_state.json`，容器重启后自动恢复。
* **🛡️ SystemValidator 智能清理**：设备连续 3 次 DHCP 检查不在线后才从配置中移除，防止容器启动瞬间 DHCP 未恢复就误清设备。
* **⏰ 定时优化**：每日 04:00 重测最优节点。游戏模式每 30 分钟静默测速，克制切换阈值 >200ms，避免频繁跳变。

---

## 📁 项目结构

```
src/
├── server.js               # 启动入口：设备同步、规则注入、守护进程
├── app.js                  # Express 路由挂载
├── config.js               # 配置管理
├── services/
│   ├── rulesEngine.js      # Clash 规则/代理组注入引擎（AI 域名 + Nintendo CDN）
│   ├── gameAccService.js   # 游戏加速：5 采样 Nintendo CDN 测速、日本加权
│   ├── aiBoostService.js   # AI 强化：单采样延迟测速、HK 过滤
│   ├── accelerationService.js # 启用/禁用加速统一入口
│   ├── sshService.js       # SSH 命令执行与文件传输
│   ├── clashService.js     # Clash HTTP API（带 10s 缓存）
│   ├── speedtestState.js   # 测速结果持久化 + LOCK/UNLOCK 状态
│   └── systemValidator.js  # 启动完整性验证（3 次确认后清理）
├── routes/
│   ├── gateway.js          # /api/status, /api/nodes, /api/select
│   ├── devices.js          # /api/devices 设备发现
│   ├── ai.js / game.js     # AI/Game 模式开关
│   ├── speedtest.js        # /api/speedtest/status, /lock, /trigger
│   └── whitelist.js        # MAC 白名单
├── utils/
│   ├── clashApiProxy.js    # Clash API 代理（SSH 隧道 + 10s 缓存）
│   └── proxyGroupDetector.js # 代理组链解析器
scripts/
├── setup_iptables.sh       # iptables TCP REDIRECT 重建
├── setup_quic_block.sh     # UDP 443 QUIC 阻断
└── check_modes.sh          # 四模式连通性检测
public/
├── index.html + app.js + style.css  # 前端 UI
```

---

## 🛠️ 前置条件

1. **路由器**：OpenWrt 或类似系统，已开启 SSH，安装 **Clash Meta (Mihomo)** 内核。
2. **NAS/服务器**：一台常开设备部署 Docker 容器。MIPS 内核 4.4.60+。
3. **SSH 凭证**：路由器 SSH 用户名和密码。

---

## ⚡ 快速启动

```yaml
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
      - ./Clash:/data/clash_backup/Clash
      - ./Country.mmdb:/data/clash_backup/Country.mmdb
      - ./configs_backup:/data/configs_backup
```

```bash
docker compose up -d --build
```

---

## 🚀 使用指南

### 三模式节点选择策略

| 模式 | 节点池 | 测速目标 | 策略 |
|------|--------|---------|------|
| 🌐 通用代理 | gRPC 全球节点 | gstatic.com | URLTest 自动选最优 |
| 🤖 AI 强化 | IPLC 中继节点（过滤香港） | generativeai.googleapis.com | 单次测速按延迟排序 |
| 🎮 游戏加速 | 日韩台节点（日本加权 25%） | Nintendo CDN | 5 次采样 → 丢包优先 → 加权延迟 |

所有模式均支持 **LOCK/UNLOCK 锁定功能**：LOCKED 状态下只更新测速结果不切换节点，仅当当前节点完全断连 (delay=0) 或 100% 丢包时才故障转移。适合对稳定性要求高的场景（如游戏联机），防止自动测速切换打断连接。

### 持久化状态

启动时自动恢复上次锁定节点（`speedtest_state.json`），容器重启不会丢失锁定状态。

---

## 🖥️ 前端功能

| 卡片 | 说明 |
|------|------|
| 网关状态 | Clash 进程运行 + 启动时长 |
| 当前节点 | 已解析的物理节点名 + 实时延迟 |
| 设备状态 | 代理设备/全部 + 模式分布进度条 |
| 磁盘占用 | /data 分区磁盘 / 内存用量 |

**节点详情弹窗**：三模式独立节点下拉（延迟排序）、游戏丢包率、LOCK/UNLOCK 一键切换。

---

## 🎮 游戏模式网络链路

```
Switch 设备
└─ TCP 流量（商店/下载/联机匹配）
   └─ iptables REDIRECT → Clash :7892
      └─ 🎮 游戏加速
         └─ 日韩台节点（日本加权优先）
            └─ Nintendo CDN (东京)
```

UDP（联机对战）不经代理，NAT 类型由运营商决定。路由器内核 4.4.60 不支持 TPROXY。

---

## 三种速度测试对比

| 测试 | DIRECT (直连) | 通用代理 | 游戏模式 |
|------|:---:|:--------:|:--------:|
| 百度首页 | ✅ 61ms | — | — |
| YouTube | ✅ 173ms | ✅ 200ms | — |
| Nintendo CDN | — | — | ✅ 58ms (0% loss) |

---

## 📄 许可证

MIT
