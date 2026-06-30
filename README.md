# Clash Meta Manager 🚀

<p align="center">
  <!-- 扁平化状态徽章 -->
  <a href="https://github.com/ctvc01/router-clash-manager"><img src="https://img.shields.io/badge/Release-v1.2.0-orange?style=flat-square" alt="Release"></a>
  <a href="https://github.com/ctvc01/router-clash-manager"><img src="https://img.shields.io/badge/Build-passing-green?style=flat-square" alt="Build"></a>
  <a href="https://github.com/ctvc01/router-clash-manager"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/ctvc01/router-clash-manager"><img src="https://img.shields.io/badge/PRs-Welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a>
</p>

<p align="center">
  <strong>专为 Clash (Mihomo) 打造的网页端设备分流与游戏加速控制台。</strong><br>
  提供设备级透明代理一键分流、AI 强化网络通道、Switch 联机节点锁定加速与防火墙自愈守护，免去逐台设备配置烦恼。
</p>

---

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

---

## ✨ 核心特性

* **📱 设备自动发现与一键分流**：局域网在线设备自动扫描并记录，支持设备别名映射。为不同成员一键分配“直连、网页代理、AI 强化、游戏加速”四种分流模式。
* **🎮 游戏加速物理锁定**：提供专线节点测速组与手动**锁定机制**。游戏设备切换物理出口后自动设为锁定，防止后台测速任务重置出口引起联机中断。
* **🤖 AI 模式避港加速**：硬编码注入 28+ 常见 AI 域名（OpenAI/Gemini/Claude 等），AI 强化出口物理过滤并排除香港节点，保障 AI 链路稳定连通。
* **🛡️ 防火墙引流自愈与 QUIC 阻断**：后台常驻防火墙守护进程。防范防火墙重启规则冲刷，自动阻断 UDP 443 QUIC 流量以强制浏览器回退 TCP 接受 HTTPS 透明劫持。
* **⚡ 极致优化的测速机制**：引入“死节点 3 秒熔断快速断联”与“2小时时效性缓存”策略，对不通节点直接短路跳过，测速流程耗时大减 60%。

---

## 🚀 快速上手

### 1. 前置准备
- 部署宿主机已安装 Docker / Docker Compose。
- 路由器上已安装运行 Clash Meta (Mihomo) 内核并开启 SSH。
- 获取路由器的 SSH 登录凭证。

### 2. 启动容器
```bash
git clone https://github.com/ctvc01/router-clash-manager.git
cd router-clash-manager

# 参考 .env.example 配置环境变量
cp .env.example .env
nano .env

# 构建并启动服务
docker compose up -d --build
```
启动后访问 `http://<宿主机IP>:3000` 即可开启设备网关控制台。

---

## ⚙️ 详细参数与架构细节

<details>
<summary><b>点击查看环境变量与高阶参数配置表 (Environment Variables)</b></summary>

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| `PORT` | `3000` | 容器 Web UI 的服务监听端口 |
| `ROUTER_IP` | `192.168.31.1` | 路由器的 LAN 局域网网关 IP |
| `ROUTER_USER` | `root` | 路由器 SSH 登录用户名 |
| `ROUTER_PASSWORD` | - | 路由器 SSH 登录密码 |
| `CLASH_PORT` | `9999` | Clash 内核 REST API 的控制端口 |
| `PROXY_PORT` | `7890` | Clash 内核监听的 HTTP/SOCKS 代理端口 |
| `DNS_PORT` | `1053` | Clash 内核的 DNS 劫持监听端口 |

</details>

<details>
<summary><b>点击查看项目目录树结构 (Directory Structure)</b></summary>

```
src/
├── server.js               # 启动入口：设备同步、规则注入、守护进程
├── app.js                  # Express 路由挂载
├── config.js               # 配置管理
├── services/
│   ├── rulesEngine.js      # Clash 规则/代理组注入引擎（AI 域名 + Nintendo CDN 域名）
│   ├── gameAccService.js   # 游戏加速：3 采样多目标 CDN 测速、区域加权、死节点熔断
│   ├── aiBoostService.js   # AI 强化：香港过滤与自愈锁定守护
│   ├── accelerationService.js # 启用/禁用加速统一入口
│   ├── sshService.js       # SSH 隧道建立、命令执行与文件传输
│   ├── clashService.js     # Clash HTTP API 交互
│   └── speedtestState.js   # 测速状态存盘与全局锁定持久化
├── routes/
│   ├── gateway.js          # /api/status, /nodes 汇总, /select 切换
│   ├── devices.js          # /api/devices 设备发现
│   └── whitelist.js        # MAC 旁路白名单管理
public/
├── index.html + app.js + style.css  # 前端单页 Web 控制台 (极简 HSL 深黑质感)
```

</details>

<details>
<summary><b>点击查看游戏模式测速与精细分流逻辑 (Routing Specs)</b></summary>

* **采样降级与死节点熔断**：测速采样缩减为更轻量的 3 次。首包测试超时 (delay === 0) 触发熔断保护，直接判定为死节点跳出，不再对该节点进行余下 2 次测试。
* **下载流量 DIRECT 逃逸**：联机与对局域名路由至 `🎮 游戏加速` 节点组，而普通大流量下载 CDN 域名（如 `*.download.nintendo.net` 等）强制直连 (`DIRECT`) 跑满物理大宽带。
* **DNS fake-ip-filter 避让**：在 DNS 注入中自动写入 `+.nintendo.net` 与 `+.nintendo.com`，使主机在联机探测时获取真实公网 IP，确保 Switch 联机 P2P 能建立 Full Cone，维持 NAT-A/B 等级。

</details>

---

## 🤝 参与贡献

非常欢迎任何形式的贡献与建议！请查阅 [Contributing Guide](CONTRIBUTING.md)。

<a href="https://github.com/ctvc01/router-clash-manager/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ctvc01/router-clash-manager" />
</a>

## 📄 开源协议

基于 [MIT](LICENSE) 协议开源。
