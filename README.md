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
* **🤖 智能 AI 强化与 SNI 流量嗅探**：
  * **AI 精准分流**：内置 Gemini/OpenAI 等主流大模型平台的域名和网络前缀规则，在规则顶部自动注入路由，将 AI 流量送往 `🤖 AI强化` 策略组，保障连接稳定并防代理组空转。
  * **SNI 连接嗅探 (Sniffer)**：在 Clash 配置文件中开启流量嗅探器，智能嗅探并解析 TLS/HTTPS 的 SNI 主机名，彻底绕过复杂笨重的 geosite 文件带来的体积瓶颈与假死。
* **💾 全自动多端灾备与一键自愈**：
  * **新硬件自愈还原**：在心跳和守护轮询中，一旦检测到全新或被重置的路由器环境（如配置为空），系统将自动从 NAS 本地读取备份，全自动重建目录、赋予权限并重构推送 `config.yaml` 配置文件和设备 MAC 绑定信息，实现一键秒级自愈。
  * **多端配置自动备份**：在每次规则应用、定时心跳及持久化写入时，系统自动将最新的 Clash 路由配置文件和 NAS 服务配置打包备份落盘在 [configs_backup/](file:///Users/cheng/Projects/router-clash-manager/configs_backup/) 下。
* **🛡️ 代理自愈与状态监控守护 (Daemon)**：
  * **高可靠进程监控**：后台定时检测 ClashCore / `mihomo` 进程状态、`7890` (代理端口) 与 `1053` (DNS端口) 的连通性，异常时自动秒级重启。
  * **连接风暴与阻塞预防**：彻底移除冗余高频 SSH 连接。Clash 重启进程采用子 Shell 重定向机制 `( ... </dev/null >/dev/null 2>/dev/null & )`，避免 Dropbear SSH 连接退出时发送 SIGHUP 杀掉 Clash 进程。
  * **防止节点超时雪崩**：精细化捕获测速和健康检测中的超时异常，避免因物理链路阻断连带导致自愈守护进程崩溃。
* **🧬 DNS 防污染与 CDN 分流**：
  * 自动修复路由器中可能导致 Fake-IP 解析死锁的配置文件星号 `*` 冲突，解决 Switch 商店打不开的顽疾。
  * 针对 Akamai 等核心 CDN 网段进行前置 ASN 拦截分流，大幅提升游戏下载与日区商店视频播放的流畅度。
* **⏰ 每日凌晨定时测速优化**：每天清晨 04:00 定时对齐任天堂全球官方测速源（`ctest.cdn.nintendo.net`）进行高并发测速，自动锁定全天最速节点。

---

## 📁 项目目录结构

项目目录经过规范整理，移除了冗余历史部署和诊断文件，其结构如下：

* [src/](file:///Users/cheng/Projects/router-clash-manager/src/) - 后端服务端核心源码，包含设备扫描、SSH 联动、自愈守护及备份服务。
  * [services/backupService.js](file:///Users/cheng/Projects/router-clash-manager/src/services/backupService.js) - 全自动配置灾备与硬件重置自愈服务。
  * [services/sshService.js](file:///Users/cheng/Projects/router-clash-manager/src/services/sshService.js) - 防死锁、高鲁棒性的路由器 SSH 指令下发核心。
* [configs_backup/](file:///Users/cheng/Projects/router-clash-manager/configs_backup/) - **多端配置备份落盘目录**，包含路由器 Clash 配置、MAC 绑定列表及服务核心配置。受 Git 跟踪以实现配置版本归档。
* [scripts/](file:///Users/cheng/Projects/router-clash-manager/scripts/) - 规范整理的辅助与诊断脚本工具箱。
  * [diagnose.sh](file:///Users/cheng/Projects/router-clash-manager/scripts/diagnose.sh) - 路由器与网关环境诊断脚本。
  * [cleanup_storage.sh](file:///Users/cheng/Projects/router-clash-manager/scripts/cleanup_storage.sh) - 磁盘及日志空间自动清理工具。
* [public/](file:///Users/cheng/Projects/router-clash-manager/public/) - 极简拟物化前端网页界面。
* [manage.sh](file:///Users/cheng/Projects/router-clash-manager/manage.sh) - **本地一体化运维管理工具**，提供状态查询、进程启停、日志流查看及多端备份。

---

## 🛠️ 运行要求（前置条件）

1. **路由器系统**：已开启 SSH 登录，且安装了 **ShellCrash (Mihomo/Clash Meta 内核)** 并确保防火墙处于运行状态。
2. **SSH 登录凭证**：你拥有该路由器的 SSH 用户名和密码（用以安全下发控制指令）。
3. **常开部署设备**：家里有一台一直开着的设备，如 **NAS（群晖/威联通）**、**闲置电脑**、**软路由**或**树莓派**。支持 Docker 容器部署或 Node.js 二进制运行。

---

## ⚡ 极速启动 (Quick Start)

对于大多数拥有 Docker 环境的用户，只需在终端中依次执行以下四步命令即可快速拉起服务：

```bash
# 1. 克隆项目到本地
git clone https://github.com/ctvc01/router-clash-manager.git

# 2. 进入项目目录
cd router-clash-manager

# 3. 复制生成本地环境变量文件并进行编辑（填入路由器 SSH 登录密码）
cp .env.example .env
nano .env

# 4. 一键后台启动容器
docker compose up -d
```

> 💡 启动成功后，您即可直接在浏览器访问 `http://<部署机器IP>:3000` 开启设备分流和联机加速控制！

---

## 🛠️ 详细安装与多方式部署

### 1. 路由器 SSH 登录凭证配置

本系统支持通过项目根目录下的 `.env` 文件进行参数管理（该文件已被写入 `.gitignore`，安全隔离，不会被提交或泄露）：

* `ROUTER_IP`：路由器网关 IP（默认 `192.168.31.1`）
* `ROUTER_USER`：SSH 登录用户名（默认 `root`）
* `ROUTER_PASSWORD`：SSH 登录密码（必需，请务必填写）

### 2. 备选部署方式：本地 Node.js 二进制直接运行

如果您不想使用 Docker，也可以直接在支持 Node.js 的物理机上启动：

1. **安装 SSH 前置工具**：确保运行系统上安装了 `expect` 和 `openssh-client`（如 macOS 下运行 `brew install expect`，Ubuntu 下运行 `sudo apt install expect openssh-client`）。
2. **下载依赖并启动**：
   ```bash
   npm install
   npm start
   ````

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

### 💾 灾备自愈与配置备份管理

#### 1. 自动备份与硬件自愈
* **自动落盘**：系统在运行期间（如更新分流规则、定时心跳），会自动同步将路由器配置与服务设置备份落盘至 [configs_backup/](file:///Users/cheng/Projects/router-clash-manager/configs_backup/) 文件夹下。
* **硬件一键自愈**：如遇路由器损坏、重置或更换为全新硬件（Clash 插件状态为空），系统在下一次心跳周期（60 秒内）会自动识别环境异常，自动读取 `configs_backup/` 的快照并重构推送，彻底完成配置的零干预自动恢复。

#### 2. 本地拉取与 Git 存档备份
在内网或公网外，均可通过本地管理脚本一键将 NAS 端的备份数据拉回本地开发目录，配合 Git 完成每一次代码修改与配置归档：

```bash
# 执行自适应同步备份指令
./manage.sh backup
```

* **极速内网同步**：如果在局域网内，脚本会通过本地 IP 直连直取；
* **外网安全穿透**：如果在外网运行，脚本会自动切换至公网 SSH 域名（`dev.jinjitu.com`），通过 `rsync` 增量拉回备份包，**完美绕过 Cloudflare Access 对 Web 端口的邮箱安全拦截验证**。

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 许可证开源，详情可参见 LICENSE 文件。
