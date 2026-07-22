# CHANGELOG (项目变更日志)

本项目严格遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范，并记录主要里程碑与演进历史。

---

## [v1.0.0] - 2026-07-23

### 🚀 核心特性与架构演进 (Core Features & Architecture)
- **零网络依赖极速自愈 (Zero-Network Self-Healing)**：内置 UPX 极致压缩内核冷备与秒级本地校验，引入 `rc.local` 掉电/重启自动守护机制 (`d96e1f0`)。
- **高可用降级直连 (HA Fallback & WebHook)**：`guard_iptables.sh` 联动透明代理与 Clash 存活状态；内核异常时秒级卸载 `PREROUTING` 引流恢复直连，进程恢复后自动重构；支持紧急自愈 WebHook (`cd1c237`)。
- **独立多场景加速组 (Dedicated Proxy Pools)**：解耦主代理、AI 强化组与游戏加速组，支持物理节点独立 LOCK/UNLOCK 与丢包率实时采样展示 (`220d320`, `e898211`, `71bf1d9`)。
- **设备四态管控 UI (Segmented Device Isolation)**：支持普通代理、游戏加速、AI 强化与直连模式互斥切换，智能合并 MAC / IP / ARP 多维设备发现 (`06638d4`, `982f05b`)。
- **QUIC / UDP 秒级降级 (QUIC Interception)**：针对 AI / Google 域名主动阻断 UDP 443 (QUIC)，强制浏览器秒级降级 TCP，消除网页卡顿与加载超时 (`e182c1f`)。

### 🐛 稳定性与崩溃修复 (Fixes & Stability)
- **BusyBox / POSIX 原生兼容 (POSIX Compliance)**：修复 `start_clash.sh` 及诊断脚本中不兼容 BusyBox 的 `ps -ef` 参数与 PID 打印问题，统一改用 `pidof` 原生语法 (`31cf178`)。
- **EPIPE 日志风暴递归死锁治理 (EPIPE Rate Limiting)**：引入 `_safeConsole` 拦截流中断异常，增加 1 秒 3 次限流与 60s 轮转间隔保护，杜绝日志递归无限风暴 (`c5474fa`)。
- **作用域与变量安全 (Scope Hardening)**：修复 `proxyHealthService` 变量在 `try` 块内声明导致的 `ReferenceError` 崩溃，缩短宕机自愈冷却间隔至 30s (`1963752`)。
- **冷重启 API 就绪等待 (Ready Check)**：修复冷重启后 Clash REST API 未建立监听导致连续 `ECONNREFUSED` 报错的缺陷 (`eec33be`)。
- **设备模式与黑名单修正 (White/Blacklists)**：无损还原 8 个设备中文自定义数据库，修复模式切换卡死与白名单路径配置问题 (`cd1c237`)。

### ⚡ 性能优化与硬超时防线 (Performance & Hardening)
- **P0 异步硬超时防线 (P0 Wall-Clock Timeout)**：对 `restartPromise`、`delayTestQueue` 及底层 `execFile` 引入 15s 硬超时兜底，杜绝异步 hang 锁死后续自愈通路 (`7b9a38a`)。
- **两级健康自愈心跳 (Two-Tier Heartbeat)**：优先在 NAS 本地通过 Axios 代理访问出海节点；Tier1 超时温和重试，Tier2 触发 SSH 诊断，彻底消除路由器 SSH 风暴 (`32f04db`, `c3d4691`, `ef361a7`)。
- **闪存自动轮转与清理 (Storage Self-Cleaning)**：实现 Level 1~3 磁盘容量分级监控，自动轮转日志与临时数据库，移除了未压缩大文件镜像，确保 Flash 占用保持在 30% 以下 (`6363b49`, `5d6f640`)。
- **串行测速队列与防抖 (Serial Speedtest Lock)**：引入 200ms 重入锁与串行测速队列，防止多路并发测速拖垮路由器 CPU (`977a7c4`, `e6a40c1`)。

### 🛡️ 安全与配置 Hygiene (Security & Hygiene)
- **无硬编码敏感凭证 (No Hardcoded Secrets)**：全面清理代码与 Compose 文件中的硬编码密码、Token 与 URL，统一改由 `.env` 环境变量加载 (`5d6f640`)。
- **SSH 指令严格黑白名单 (SSH Command Validator)**：建立命令安全防护链，阻断高危 `rm` 及非预期命令执行，保障硬件与嵌入式环境安全 (`a49f224`, `8c73d32`)。
- **POSIX 运维脚本集 (POSIX Operational Scripts)**：重构并统一 `cleanup_storage.sh`、`deploy.sh`、`diagnose.sh`、`root_cause_analysis.sh` 运维工具集 (`5d6f640`)。
