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

**Clash Meta** 是一款专为家用/软路由环境打造的 Clash (Mihomo) 辅助控制台。它通过一个极简、直观的 Web 界面，让你免去繁琐的命令行操作，即可远程管理局域网内每个设备的上网状态，并针对主机游戏（如 Switch）联机体验提供了深度优化。

本项目后端基于 Node.js 运行，通过 SSH 协议与路由器上的 **ShellCrash (Mihomo 内核)** 插件进行安全联动，操控防火墙设备白名单与 Clash 策略组。

---

## 🎯 解决什么痛点？（使用场景）

* **多设备网络分流**：家里设备众多，不同设备分流需求不同。例如：爸妈手机和客厅电视需要国内直连（防止国内 App/电视盒子假死变慢），而你的手机、PC 需要走网页代理，智能家居走直连。
* **联机对局易掉线**：Switch 等主机在进行联机匹配时，如果 Clash 的 `url-test` 测速策略自动切换节点，会导致设备出口 IP 发生突变，直接引发匹配中断或联机掉线。
* **日区商店与 DNS 报错**：Switch 频繁提示连接测试失败、DNS 解析失败（如 2811-1006 报错），或无法进入任天堂 eShop 商店。

---

## 🌟 核心功能

* **📱 设备扫描与中文命名**：自动扫描局域网内的在线设备，支持绑定中文备注名称并进行设备分类（手机、电视、主机、PC、IoT等），配合拟物图标展示。
* **⚡ 设备三态一键分流**：
  * **直连 (DIRECT)**：绕过 Clash，设备直接通过网关发包（国内网络速度最快）。
  * **代理 (Proxy)**：设备流量重定向至 Clash，走网页代理策略组。
  * **游戏 (Game)**（仅限主机分类）：流量被送往专属的 `🎮 游戏加速` 策略组，支持一键**锁死物理专线节点**，彻底解决因自动测速切换节点导致的联机断线。
* **🛡️ 代理自愈与健康监测 (Daemon)**：
  * **进程与端口守护**：后台每 60 秒轮询检测 ClashCore 进程状态、`7890 (代理端口)` 与 `1053 (DNS端口)` 的连通性，假死时自动秒级重启。
  * **链路监控与自动漂移**：定时检测海外链路连通性，若遇突发阻断则强行下发测速指令，促使 Clash 节点漂移自愈。
* **🧬 DNS 防污染与 CDN 分流**：
  * 自动修复路由器中可能导致 Fake-IP 解析死锁的配置文件星号 `*` 冲突，解决 Switch 商店打不开的顽疾。
  * 针对 Akamai 等核心 CDN 网段进行前置 ASN 拦截分流，大幅提升游戏下载与日区商店视频播放的流畅度。
* **⏰ 每日凌晨定时测速优化**：每天清晨 04:00 定时对齐任天堂全球官方测速源（`ctest.cdn.nintendo.net`）进行高并发测速，自动锁定全天最速节点。

---

## 🛠️ 运行要求（前置条件）

1. **路由器系统**：已开启 SSH 登录，且安装了 **ShellCrash (Mihomo/Clash Meta 内核)** 并确保防火墙处于运行状态。
2. **SSH 登录凭证**：你拥有该路由器的 SSH 用户名和密码（用以安全下发控制指令）。
3. **常开部署设备**：家里有一台一直开着的设备，如 **NAS（群晖/威联通）**、**闲置电脑**、**软路由**或**树莓派**。支持 Docker 容器部署或 Node.js 二进制运行。

---

## 🚀 快速安装与配置

### 1. 配置路由器凭证

为了防止您的路由器密码等敏感信息泄露至 Git 历史，本系统推荐使用环境变量进行安全配置：

* **Node.js 直接运行（本地配置文件）**：
  在项目根目录下复制模板生成 `.env` 配置文件：
  ```bash
  cp .env.example .env
  ```
  编辑新生成的 `.env` 文件，填入您的路由器 IP、登录用户名及密码。
  
* **Docker Compose 运行（容器注入）**：
  直接在 `docker-compose.yml` 中的 `environment` 部分或容器启动时，注入以下环境变量即可：
  * `ROUTER_IP`（路由器网关 IP，默认 `192.168.31.1`）
  * `ROUTER_USER`（SSH 登录用户名，默认 `root`）
  * `ROUTER_PASSWORD`（SSH 密码，必需）

### 2. 部署运行

#### 方式 A：使用 Docker Compose 一键启动（推荐）
在项目目录下执行命令：
```bash
docker compose up -d
```
启动成功后，控制台服务将默认运行在本地的 `3000` 端口。

#### 方式 B：使用 Node.js 直接运行
1. 确保部署系统上安装了 `expect` 和 `openssh-client` 工具（如 macOS 下运行 `brew install expect`）。
2. 在项目目录下安装依赖并启动：
   ```bash
   npm install
   npm start
    ```

#### 🧪 运行本地单元测试

为了确保数据输入安全与防 Shell 注入安全策略的可靠性，本系统包含完整的自动化测试套件。您可以通过以下命令在本地执行验证：
```bash
npm run test
```

---

## 🚀 使用指南

1. 打开浏览器访问 `http://<部署机器IP>:3000`。
2. 在设备卡片上点击“编辑”给设备起好备注名并选择分类（例如把 Nintendo Switch 归类为“主机”）。
3. 选择对应的分流模式即可瞬间下发命令控制设备。
4. 页脚会实时显示当前路由器的 Clash 内核版本与局域网总流量上下行速率。

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 许可证开源，详情可参见 LICENSE 文件。
