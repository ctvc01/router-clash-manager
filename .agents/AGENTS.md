# 🛰️ 智能硬件与代理系统全局开发规范 (Global Agent Rules)

本文件定义了系统开发、智能硬件操作、网络代理维护等所有项目的全局行为红线、核心哲学与安全规范。所有 AI 代理在进行设计、编码、调试和执行时必须无条件严格遵守。

---

## 🎯 第一部分：核心哲学 (Core Philosophy)

### 1.1 极简开发原则 (Ponytail / YAGNI)
我们崇尚“最少且最简洁的代码，才是最稳定的代码”。在编写任何代码前，AI 必须依次进行以下层级的自我追问，并在符合条件时立即停止编写新代码：
1. **必要性检查**：该功能真的需要构建吗？（YAGNI 原则，如非必要，勿增实体）
2. **复用性检查**：当前代码库中是否存在可复用的辅助函数、工具类或设计模式？
3. **原生性检查**：系统标准库是否已经提供了该功能？（优先使用语言标准库）
4. **特性级检查**：平台原生特性（如系统的网络协议、操作系统的内置机制）是否已经涵盖了该需求？
5. **依赖级检查**：项目中已安装的第三方依赖包是否可以直接解决该问题？
6. **行数级检查**：该逻辑能否浓缩为一行代码？
7. **极简编写**：只有在以上 1-6 条均不满足时，才着手编写满足需求的最少代码。

### 1.2 治本而非治标 (Root Cause Fixes)
* **根源治理**：Bug 报告往往只描述了症状。在修复 Bug 时，禁止仅在触发错误的调用处编写局部补丁。
* **联合检索**：必须全局检索受影响函数的所有调用者，在公共库或最底层的逻辑源头进行统一拦截和治理，消除同类隐患。
* **简洁守卫**：对于为了极致精简而做出的已知性能或设计妥协（如使用全局锁、O(N) 扫描等），代码中必须使用 `// ponytail: [妥协说明与后续升级路径]` 显式注释标注。

---

## 🔐 第二部分：敏感凭证与安全规范 (Security & Credentials)

### 2.1 环境变量优先 (Environment Over Hardcoding)
* **严禁硬编码**：禁止将任何账号密码、局域网 IP、API 密钥、Token 等敏感信息硬编码写入代码或任何会被 Git 追踪的配置文件中。
* **全局变量路由**：
  - **内网/VPN DNS**：读取系统环境变量 `$COMPANY_VPN_IP` (Node.js：`process.env.COMPANY_VPN_IP`)。
  - **局域网网关 IP**：读取系统环境变量 `$ROUTER_GATEWAY` (Node.js：`process.env.ROUTER_GATEWAY`)。
  - **敏感密码/Token**：优先通过 `process.env`（如 `process.env.DB_PASSWORD`）获取。
* **物理隔离**：对于高安全场景的凭证读取，引导用户使用 `security find-generic-password` 从 macOS 钥匙串中安全提取，防止凭证在环境中泄露。
* **重构义务**：一旦在既有代码中发现硬编码敏感数据，必须立即重构为环境变量加载，并通知用户。

---

## 🛡️ 第三部分：系统稳定性与防灾红线 (System Stability & Safety Guardrails)

### 3.1 系统安全性 (Anti-Explosion & Anti-Crash)
* **严禁全局重置网络**：在路由器系统上，绝对禁止全局清空或重启防火墙/网络服务（如 `iptables -F`，`/etc/init.d/network restart` 等）。任何调整必须针对特定规则链或使用细粒度局部脚本。
* **切断信号联动**：凡是通过 SSH 启动常驻后台服务（如 Clash、mihomo 等）的指令，必须包装在子 Shell 中并重定向输入输出（防止 SSH 会话关闭时发送 `SIGHUP` 导致进程退出）：
  ```bash
  ( /tmp/ShellCrash/mihomo -d /data/ShellCrash -f /data/ShellCrash/config.yaml </dev/null >/dev/null 2>/dev/null & )
  ```
* **防范端口冲突与死锁**：在重载或重启服务前，必须添加端口占用检测或缓冲延迟（如 `sleep 1.5`），防止新旧进程冲突导致代理瘫痪。

### 3.2 接口与网络超时 (Network & Timeout)
* **硬性超时与安全捕获**：网络连接不可靠。任何远程指令或 API 请求（如 Axios）必须设置硬性超时（如 `timeout: 5000`）并包裹在 `try-catch` 中进行异常兜底捕获，严禁未捕获 of 异步空跑导致主进程崩溃。
* **重试与退避机制**：对于偶发性的连接重置或 Dropbear 拒绝连接，实现自适应指数退避重试（退避 500ms，最多重试 3-5 次），保障高负荷下的网络健壮性。

### 3.3 并发防拥堵 (Concurrency & Cache)
* **内存缓存屏障**：对于慢速设备或路由器的轮询查询接口（如设备列表，每 10-15s），后端必须引入短时内存缓存（TTL 10~15秒）。严禁无缓存的轮询直达 SSH 物理执行层，防止 CPU 过载。
* **串行锁与防抖**：对高频或可能导致配置变动的操作（如切换设备代理模式），必须在接口端设计排队串行锁或防抖（Debounce）处理。

### 3.4 配置防腐与极简运行 (Configuration & Compatibility)
* **配置文件纯净**：在可被正则解析的配置文件中，严禁写入包含空格、斜杠（`/`）或非标准字符的行内注释，防止 YAML 解析报错引发自愈死锁。
* **POSIX sh 兼容**：项目的所有辅助和检测脚本，必须使用标准的 `#!/bin/sh`（不依赖 Bash-only 语法，如 `+=` 拼接、扩展括号 `{}` 等），以确保在 BusyBox 和 Alpine 极简环境中无障碍运行。

---

## 📁 第四部分：持久化记忆协议 (Memory Bank Protocol)

为了确保智能体在复杂、长周期的项目中保持上下文的一致性，防止会话截断（Compaction）和重启导致的项目记忆丢失，所有 Agent 必须无条件遵循以下持久化记忆协议：

### 4.1 启动必读 (Booting Protocol)
* 处理任何新指令前，Agent 必须优先检查项目根目录是否存在 `.memory_bank/` 目录。
* 如果存在，必须在执行任何修改前，使用文件查看工具首先读取 `productContext.md`（项目定义与架构）和 `activeContext.md`（当前状态与近期决策）以找回项目记忆。

### 4.2 状态同步 (State Synchronization)
* 每完成一个功能点、修复一个 Bug 或做出一项重大的逻辑修改，Agent 必须立即同步更新 `.memory_bank/` 目录下的 `progress.md`（增量开发日志）和 `todo.md`（任务追踪清单）。
* 记录当前“做了什么”、“接下来的待办”以及在开发中遇到的“新坑或妥协”。

### 4.3 架构守卫 (Architecture Guardrail)
* Agent 编写或修改代码时，严禁做出与 `productContext.md` 记录的既定架构规范相违背的修改。如果确需变更，必须在实施前与用户进行明确的沟通并获取正式审批。

---

## 🚀 第五部分：规则扩展锚点 (Extension Slot - 供后续追加使用)
* *(此区域预留，方便未来追加特定的部署流水线规则、测试规则等)*

### 核心规约区 (Core Rules)
<!-- rule-evolution:core-start -->
<!-- rule-evolution:core-end -->

### 草案孵化区 (Draft Rules)
<!-- rule-evolution:draft-start -->
### 5.1 前端状态即时刷新与长耗时任务的静默自愈 (UI State Hydration & Silent Polling)
* **正面指导原则**：当后端接口包含长耗时的异步后台测速或硬件交互，且为防止阻塞前端而立即返回 `success` 时，前端**必须**在收到成功响应后立即主动拉取一次最新状态（Instant UX），使 UI（如锁定徽标）实现零延迟更新。对于后端未完成的异步结果（如 3-4 秒后才得出的测速/丢包率），前端应通过 `setTimeout` 延迟几秒进行一次无 Loading 的静默拉取（Silent Hydration），从而无感地将最终数据刷入界面。
* **反面避坑 (Anti-Pattern)**：严禁前端在执行完状态变更操作后，仅仅依赖全局的 `setInterval` 轮询（如 30s 一次）来被动刷新数据。这会导致用户产生“操作卡顿”或“延迟 5 秒才生效”的错觉（因为轮询的残余时间不可控）。状态变更操作必须配对主动状态拉取。 <!-- hits:1 created:2026-07-05 session:优化游戏模式节点锁定徽标5秒延迟UX -->
<!-- rule-evolution:draft-end -->

### 个人偏好区 (User Prefs)
<!-- rule-evolution:user-prefs-start -->
<!-- rule-evolution:user-prefs-end -->

### 拒绝记录区 (Rejected Rules)
<!-- rule-evolution:rejected-start -->
<!-- rule-evolution:rejected-end -->
