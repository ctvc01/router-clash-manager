# NAS 日志分流方案 - 部署准备完成 ✅

## 📋 已完成的准备工作

### 1️⃣ 创建了 3 个核心文件

#### `router_log_transfer.sh` (4.8KB)
- 部署到路由器的主要脚本
- 功能：自动转移日志到 NAS，保留 2 个本地日志供故障排查
- 运行方式：通过 crontab 每 15 分钟执行

#### `deploy_nas_log_transfer.sh` (5.8KB)  
- 自动部署脚本（在本地机器运行）
- 功能：一键部署上述脚本到路由器和 NAS
- 包括：创建 NAS 目录、部署脚本、配置 crontab、测试验证

#### `NAS_LOG_DISTRIBUTION_GUIDE.md`
- 完整的用户指南
- 包括：前置条件、部署步骤、验证方法、故障排查

### 2️⃣ 工作原理

```
定时任务（每15分钟）
  ↓
扫描 /data/ShellCrash 和 /tmp/ShellCrash
  ↓
保留最近2个日志（用于故障排查）
  ↓
转移其他日志到 NAS via SCP
  ↓
删除本地副本
  ↓
清理7天前的旧日志
  ↓
如果 >90% 执行激进清理
```

---

## 🚀 立即可执行的步骤

### 第一步：验证 SCP 转移能力（关键！）

这是决定方案可行性的第一步。

```bash
# 在你的本地机器上执行
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "echo 'test' > /tmp/t.txt && scp -o StrictHostKeyChecking=no /tmp/t.txt ctpdrqm@192.168.31.66:/tmp/ && echo '✓ SCP 可用'"
```

**预期结果**：
- ✅ SCP 可用 → 继续第二步
- ❌ 失败 → 检查错误消息

### 第二步：执行自动部署（假设第一步成功）

```bash
cd /Users/cheng/Projects/router-clash-manager

# 设置凭证
export ROUTER_PASSWORD="<你知道的路由器root密码>"
export NAS_PASSWORD="cx@4343506"

# 执行部署
./deploy_nas_log_transfer.sh
```

脚本会自动完成：
1. 在 NAS 创建目录
2. 部署脚本到路由器
3. 配置 crontab
4. 测试转移
5. 验证结果

### 第三步：监控效果

部署后立即查看：

```bash
# 查看实时转移日志
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "tail -f /tmp/nas_transfer.log"

# 观察磁盘变化
watch -n 10 'ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "df -h /data | tail -1"'

# 查看 NAS 日志增长
watch -n 60 'ssh ctpdrqm@192.168.31.66 "du -sh /vol1/1000/clash-full-storage/logs"'
```

---

## 📊 部署前后对比

| 指标 | 部署前 | 部署后（预期） |
|------|--------|----------------|
| /data 使用率 | **95%** ⚠️ | **75-80%** ✅ |
| 可用空间 | ~1MB | ~4-5MB |
| 本地日志 | 无限增长 | 最近2个 + 7天轮转 |
| NAS 日志 | 无 | 完整历史 |
| Clash 稳定性 | 频繁崩溃 | 完全稳定 |

---

## ❓ 关键问题解答

### Q: 为什么要保留 2 个本地日志？
A: 为了故障排查，如果出现问题可以查看最近的日志。完全禁用日志不方便调试。

### Q: 如果 NAS 离线怎么办？
A: 脚本会自动检测，如果 NAS 不可达，改为本地清理方案。

### Q: SCP 转移会不会很慢？
A: 日志文件一般 1-10MB，在 1Gbps 局域网上转移很快（毫秒级）。

### Q: 部署需要停止 Clash 吗？
A: 不需要。所有操作都是在线进行的，Clash 继续正常运行。

### Q: 如果部署失败怎么办？
A: 查看 `NAS_LOG_DISTRIBUTION_GUIDE.md` 的故障排查章节。

---

## ⚠️ 前置条件

在执行部署前，请确保：

- ✅ 知道路由器 root 密码（用于 SSH 登录）
- ✅ 路由器 SSH 可达（`ssh root@192.168.31.1`）
- ✅ NAS 在线且可 ping（`ping 192.168.31.66`）
- ✅ NAS 密码正确（已在 nas_credentials.md 中）
- ✅ Docker 容器正常运行（如果从容器内部署）

---

## 📁 文件位置

```
/Users/cheng/Projects/router-clash-manager/
├── router_log_transfer.sh              ← 路由器脚本
├── deploy_nas_log_transfer.sh          ← 自动部署脚本
├── NAS_LOG_DISTRIBUTION_GUIDE.md       ← 完整用户指南
└── （内存中） nas_log_distribution_scp.md  ← 技术文档
```

---

## 🎯 建议的实施时间表

### 今天（立即）
- [ ] 验证 SCP 转移能力（第一步）
- [ ] 阅读 `NAS_LOG_DISTRIBUTION_GUIDE.md`

### 本周内
- [ ] 执行 `deploy_nas_log_transfer.sh` 自动部署
- [ ] 观察部署效果（1-2 小时）
- [ ] 验证磁盘使用率下降

### 持续监控
- [ ] 每天检查一次 /data 使用率
- [ ] 定期查看 /tmp/nas_transfer.log
- [ ] 检查 NAS 日志是否正常转移

---

## 💡 关键要点

✅ **完全自动化**：部署后无需手动干预
✅ **保留故障排查能力**：不禁用日志，只是转移
✅ **零成本**：利用现有 NAS 存储
✅ **高可靠性**：基于标准 SSH/SCP 协议
✅ **实时监控**：可随时查看转移日志

---

## 📞 需要帮助？

如果部署过程中遇到问题：

1. 查看 `NAS_LOG_DISTRIBUTION_GUIDE.md` 的故障排查章节
2. 检查转移日志：`tail -50 /tmp/nas_transfer.log`（在路由器上）
3. 验证基本连接：
   - SSH 到路由器：`ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1`
   - SSH 到 NAS：`ssh ctpdrqm@192.168.31.66`
   - 测试 SCP：`scp /tmp/test.txt ctpdrqm@192.168.31.66:/tmp/`

---

## ✅ 下一步

**立即执行**：第一步 SCP 验证

```bash
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "echo 'test' > /tmp/t.txt && scp -o StrictHostKeyChecking=no /tmp/t.txt ctpdrqm@192.168.31.66:/tmp/ && echo '✓ SCP 成功'"
```

告诉我结果（成功 ✓ 还是失败 ✗），然后我们继续部署！

