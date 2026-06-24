# Clash Meta 🚀
> Clash (Mihomo) 网页端设备分流与游戏加速管理器

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

**Clash Meta** 是一款 Clash (Mihomo) 辅助控制台。通过容器部署，以 SSH 协议安全联动 Clash Meta 内核，提供设备级透明代理、AI 强化分流和 Switch 游戏加速功能。

---

## 🎯 使用场景

* **🧑‍👩‍👧‍👦 多设备策略统一管理**：手机要翻墙，电视要直连（否则国内 App 卡顿），Switch 需要游戏专线。Web UI 为每台设备一键分配独立策略，无需逐台配置。
* **🎮 Switch 联机不掉线**：节点自动切换时出口 IP 突变会打断任天堂联机匹配。游戏模式提供节点**锁定功能**，永不自动切换。配合 Nintendo CDN 域名规则，商店和下载走游戏专线。
* **🤖 AI 服务加速**：香港 IP 被 Google AI 服务封禁，普通代理可能路由到香港出口导致无法访问。AI 强化模式排除香港节点，保障 AI API 稳定连接。
* **❌ YouTube 无法播放**：浏览器优先使用 QUIC (UDP 443) 绕过透明代理。系统自劫阻断 QUIC 回退到 TCP，配合 SNI 嗅探确保 HTTPS 正常代理。
* **🔄 配置自愈**：系统启动时自动检测并恢复代理配置、设备白名单和转发规则，无需手动干预。

---

## 🌟 核心功能

* **📱 设备自动发现与策略分流**：自动扫描在线局域网设备，支持自定义别名。一键切换**直连/代理/AI 强化/游戏加速**四种状态。
* **🎮 游戏加速**：独立游戏节点池，实测目标 CDN 选优。5 次多采样丢包+延迟测速，**丢包率优先**再比延迟。
* **🤖 AI 强化**：硬编码 28+ AI 域名规则（OpenAI/Gemini/Claude/Google AI），独立节点池排除香港，确保 AI 服务稳定。
* **🔒 LOCK/UNLOCK 锁定机制**：锁定节点后不触发测速切换，仅断连或 100% 丢包时才故障转移。任何模式均可启用。
* **🧬 SNI 嗅探**：TLS 连接嗅探，无需 geoip/geosite 数据库即可识别目标域名。
* **🛡️ SystemValidator**：设备连续多次检查不在线后才从配置中移除，防止启动瞬间误清。
* **⏰ 定时优化**：每日凌晨重测最优节点。常规测速每 30 分钟一次，克制切换阈值 >200ms。

---

## 📁 项目结构

```
src/
├── server.js               # 启动入口：设备同步、规则注入、守护进程
├── app.js                  # Express 路由挂载
├── config.js               # 配置管理
├── services/
│   ├── rulesEngine.js      # Clash 规则/代理组注入引擎（AI 域名 + Nintendo CDN 域名）
│   ├── gameAccService.js   # 游戏加速：5 采样多目标 CDN 测速、区域加权
│   ├── aiBoostService.js   # AI 强化：单采样延迟测速、香港过滤
│   ├── accelerationService.js # 启用/禁用加速统一入口
│   ├── sshService.js       # SSH 命令执行与文件传输
│   ├── clashService.js     # Clash HTTP API（带缓存）
│   ├── speedtestState.js   # 测速结果持久化 + LOCK/UNLOCK 状态
│   └── systemValidator.js  # 启动完整性验证
├── routes/
│   ├── gateway.js          # /api/status, /api/nodes, /api/select
│   ├── devices.js          # /api/devices 设备发现
│   ├── ai.js / game.js     # AI/Game 模式开关
│   ├── speedtest.js        # /api/speedtest/status, /lock, /trigger
│   └── whitelist.js        # MAC 白名单管理
├── utils/
│   ├── clashApiProxy.js    # Clash API 代理（SSH 隧道 + 缓存）
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

* 部署设备上安装 Docker 和 docker-compose
* 目标路由器已开启 SSH，安装了 Clash Meta (Mihomo) 内核
* 知晓路由器的 SSH 登录凭证

---

## ⚡ 快速启动

```bash
git clone <your-repo-url>
cd router-clash-manager

# 参考 .env.example 配置环境变量
docker compose up -d --build
```

---

## 🖥️ 前端页面

| 卡片 | 说明 |
|------|------|
| 网关状态 | Clash 进程运行状态 + 启动时长 |
| 当前节点 | 已解析的物理节点名 + 实时延迟 |
| 设备状态 | 代理设备/全部设备 + 模式分布进度条 |
| 磁盘占用 | 磁盘用量监控 |

**节点详情弹窗**：三模式独立节点下拉（延迟排序）、游戏丢包率显示、LOCK/UNLOCK 一键锁定。

---

## 🎮 游戏模式测速策略

| 指标 | 说明 |
|------|------|
| 采样 | 每节点 5 次，间隔 200ms |
| 测速目标 | 任天堂 CDN（连通性 + 下载点） |
| 区域加权 | 日本节点权重 0.75、台湾 0.85、韩国 0.90 |
| 排序策略 | 丢包率优先 → 同丢包按加权延迟 |
| LOCKED | 只更新测速结果不切换，断连时故障转移 |

---

## 📄 许可证

MIT
