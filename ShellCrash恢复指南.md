# ShellCrash 恢复指南

## 情况说明

路由器 `/data/ShellCrash` 安装不完整，需要重新安装。由于 GitHub 无法访问，提供多个恢复方案。

## 方案一：通过 OpenWrt 应用商店安装（推荐）

**最简单，最可靠的方式**

1. 打开浏览器访问 `http://192.168.31.1:80`（OpenWrt 管理界面）
2. 登录路由器管理后台
3. 找到"应用"或"插件"菜单
4. 搜索 "ShellCrash" 或 "Clash"
5. 点击"安装"
6. 等待 3-5 分钟安装完成
7. 安装完成后会自动启动

**验证**：
```bash
ssh root@192.168.31.1 "pidof CrashCore && echo '✅ Clash 已启动'"
```

---

## 方案二：手动下载并上传

**适用于已有 Clash 内核的情况**

1. 如果你之前备份了 Clash 内核，可以通过 SCP 上传到路由器：
   ```bash
   scp -o PubkeyAcceptedAlgorithms=+ssh-rsa /path/to/Clash root@192.168.31.1:/data/ShellCrash/
   chmod +x /data/ShellCrash/Clash
   ```

2. 然后运行启动脚本：
   ```bash
   ssh root@192.168.31.1 "sh /data/ShellCrash/emergency_start.sh"
   ```

---

## 方案三：从 Clash Meta 官方下载

**如果 OpenWrt 无法访问应用商店**

1. 在你的 PC/NAS 上下载 Clash Meta 内核：
   ```bash
   # 根据路由器 CPU 架构选择合适的版本
   # 小米路由器通常是 mipsle 或 arm
   
   # 从 Clash 官方获取：
   https://github.com/MetaCubeX/mihomo/releases
   
   # 或从备用源：
   https://mirror.ghproxy.com/https://github.com/MetaCubeX/mihomo/releases
   ```

2. 下载完成后上传到路由器：
   ```bash
   scp -o PubkeyAcceptedAlgorithms=+ssh-rsa ~/Downloads/mihomo root@192.168.31.1:/data/ShellCrash/Clash
   ssh root@192.168.31.1 "chmod +x /data/ShellCrash/Clash"
   ```

3. 启动：
   ```bash
   ssh root@192.168.31.1 "sh /data/ShellCrash/emergency_start.sh"
   ```

---

## 方案四：从 NAS 容器中转下载

**如果路由器无法直接访问 GitHub**

1. 在 NAS 容器上下载：
   ```bash
   docker exec clash-meta bash -c "wget -O /tmp/Clash https://..."
   scp ctpdrqm@dev.jinjitu.com:/tmp/Clash root@192.168.31.1:/data/ShellCrash/
   ```

---

## 快速验证

**检查 Clash 是否正常运行**：

```bash
# 1. 检查进程
ssh root@192.168.31.1 "pidof CrashCore || pidof crashcore || echo '进程未运行'"

# 2. 检查端口监听
ssh root@192.168.31.1 "netstat -nlt | grep -E '(7890|1053|9999)'"

# 3. 检查日志
ssh root@192.168.31.1 "tail -20 /data/ShellCrash/run.log"

# 4. 测试代理连接
ssh root@192.168.31.1 "curl -I -x http://127.0.0.1:7890 http://cp.cloudflare.com/generate_204"
```

---

## 故障排查

| 问题 | 症状 | 解决方案 |
|------|------|--------|
| 内核缺失 | 启动脚本报错"未找到二进制文件" | 上传 Clash 内核 |
| 配置损坏 | Clash 启动立即崩溃 | 检查 `/data/ShellCrash/yamls/config.yaml` |
| 端口被占用 | 启动失败"端口已被占用" | 重启路由器或杀死旧进程 |
| 启动错误标记 | `.start_error` 存在导致无法启动 | 运行 `rm -f /data/ShellCrash/.start_error` |

---

## 容器自动检测

NAS 容器已配置自动检测：
- 每 60 秒检查一次 Clash 进程
- 如果发现异常会尝试自动重启
- 重启后会进入 90 秒冷却期避免频繁重启
- 日志中会显示状态："✅ 全部检查通过" 或 "⚠️ 检测到异常"

---

## 建议操作顺序

1. **优先尝试**方案一（应用商店安装）
2. 如果不行，尝试**方案三**（手动下载上传）
3. 验证通过后，容器会自动接管监控

完成后，网关应该恢复正常运行！

