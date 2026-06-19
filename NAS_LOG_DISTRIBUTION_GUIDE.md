---
name: NAS 日志分流实施指南（第一步验证）
description: 分步骤指导如何将路由器 Clash 日志转移到 NAS，保留本地日志用于故障排查
type: project
---

## 🎯 目标

- ✅ 将路由器 Clash 日志自动转移到 NAS
- ✅ 保留本地日志供故障排查（不完全禁用）
- ✅ 释放路由器 /data 分区空间（从 95% 降到 <85%）
- ✅ 确保 Clash 稳定运行

---

## 📋 前置条件检查

在开始部署前，请验证：

```bash
# 1. NAS 连接正常
ping 192.168.31.66

# 2. 路由器 SSH 可达
ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "echo 'OK'"

# 3. SCP 工具可用
which scp
```

---

## 🚀 第一步：验证 SCP 传输能力

**这是最关键的一步，决定了整个方案是否可行。**

### 方法 1：直接在路由器上测试（推荐）

```bash
#!/bin/bash
# 在本地执行（连接到路由器并测试 SCP）

ROUTER_IP="192.168.31.1"
ROUTER_USER="root"
NAS_IP="192.168.31.66"
NAS_USER="ctpdrqm"

echo "步骤 1: 登录路由器并创建测试文件"
ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa "$ROUTER_USER@$ROUTER_IP" \
  "echo 'SCP transfer test' > /tmp/test_transfer.txt && ls -lh /tmp/test_transfer.txt"

echo ""
echo "步骤 2: 从路由器尝试 SCP 到 NAS"
ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa "$ROUTER_USER@$ROUTER_IP" \
  "scp -o StrictHostKeyChecking=no -o ConnectTimeout=5 /tmp/test_transfer.txt $NAS_USER@$NAS_IP:/tmp/ && echo '✓ SCP 成功'"

echo ""
echo "步骤 3: 验证文件是否在 NAS 上"
# 需要能 SSH 到 NAS
```

### 方法 2：通过 Docker 容器测试

如果路由器 SSH 密码不知道，可以在 Docker 容器内测试（容器有正确的 SSH 配置）：

```bash
docker compose exec -T clash-meta /bin/bash << 'TEST_SCP'
#!/bin/bash

# 测试 SCP 能力
echo "测试 SCP 转移..."
echo "test file" > /tmp/test.txt

# 尝试转移到 NAS（需要 NAS 密码）
export SSHPASS="cx@4343506"
sshpass -e scp -o StrictHostKeyChecking=no /tmp/test.txt ctpdrqm@192.168.31.66:/tmp/ && echo "✓ SCP 成功"

rm -f /tmp/test.txt
TEST_SCP
```

### 验证结果

- ✅ **成功**：文件出现在 NAS `/tmp/` 或指定目录 → 继续第二步
- ❌ **失败**：看具体错误消息并排查：
  - "Permission denied" → NAS 密码错误
  - "Connection timeout" → 网络问题
  - "No such file or directory" → NAS 目录不存在

---

## 🔧 第二步：部署 NAS 日志分流

### 准备工作

```bash
cd /Users/cheng/Projects/router-clash-manager

# 确保脚本存在
ls -lh router_log_transfer.sh deploy_nas_log_transfer.sh
```

### 执行部署脚本

```bash
# 设置环境变量（路由器和 NAS 的密码）
export ROUTER_PASSWORD="<路由器 root 密码>"  # 需要知道
export NAS_PASSWORD="cx@4343506"             # NAS 密码

# 执行部署
./deploy_nas_log_transfer.sh
```

**脚本会自动执行以下步骤：**

1. ✅ 在 NAS 上创建日志目录
2. ✅ 部署日志转移脚本到路由器
3. ✅ 配置 crontab（每 15 分钟执行一次）
4. ✅ 执行测试转移
5. ✅ 验证部署结果

---

## 📊 部署后验证

### 1. 检查路由器脚本是否已部署

```bash
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "ls -lh /data/scripts/log_transfer.sh && cat /tmp/nas_transfer.log | tail -20"
```

**预期输出：**
```
-rwxr-xr-x    1 root     root         4.8K Jun 19 16:41 /data/scripts/log_transfer.sh
[2026-06-19 16:45:00] ========== 日志转移流程开始 ==========
[2026-06-19 16:45:01] ✅ NAS 可到达
[2026-06-19 16:45:05] ✓ 已转移: ShellCrash.log.1
[2026-06-19 16:45:06] 本次转移 1 个日志文件
...
```

### 2. 检查 NAS 上的日志是否在增加

```bash
ssh -o StrictHostKeyChecking=no ctpdrqm@192.168.31.66 \
  "ls -lh /vol1/1000/clash-full-storage/logs/ && du -sh /vol1/1000/clash-full-storage/logs/"
```

**预期：** 应该看到转移过来的日志文件在不断增加

### 3. 检查路由器的磁盘使用率

```bash
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "df -h /data && du -sh /data/ShellCrash"
```

**预期：** 使用率应该从 95% 逐渐下降到 85% 以下

---

## 🎯 工作原理

```
路由器定时任务（每 15 分钟）
    ↓
扫描 /data/ShellCrash 和 /tmp/ShellCrash 中的日志
    ↓
保留最近 2 个日志文件（用于故障排查）
    ↓
将其他日志转移到 NAS via SCP
    ↓
删除本地副本
    ↓
检查磁盘使用率，如果 >90% 执行激进清理
    ↓
定期清理 7 天前的本地日志
```

---

## 📈 预期效果

| 指标 | 部署前 | 部署后 | 改善 |
|------|--------|--------|------|
| /data 使用率 | 95% | 70-80% | ↓ 15-25% |
| 可用空间 | ~1MB | ~4-6MB | ↑ 4-5x |
| 本地日志保留 | 有限 | 最近2个 + 7天轮转 | 更合理 |
| NAS 日志 | 无 | 完整历史 | 便于排查 |
| Clash 稳定性 | 频繁崩溃 | 持续运行 | ✅ 完全解决 |

---

## ⚠️ 故障排查

### 问题 1: SCP 转移失败

**错误信息：**
```
Permission denied (publickey,password).
```

**原因：** NAS 密码错误或网络问题

**解决：**
```bash
# 测试 NAS 连接
ssh -o StrictHostKeyChecking=no ctpdrqm@192.168.31.66 "echo 'OK'"

# 如果失败，检查密码
export NAS_PASSWORD="cx@4343506"  # 尝试正确密码
```

### 问题 2: 路由器上的脚本不运行

**检查 crontab：**
```bash
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "crontab -l"
```

**预期看到：**
```
*/15 * * * * /data/scripts/log_transfer.sh
```

如果没有，重新执行部署脚本或手动添加：
```bash
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "(crontab -l 2>/dev/null; echo '*/15 * * * * /data/scripts/log_transfer.sh') | crontab -"
```

### 问题 3: NAS 目录不存在

**检查：**
```bash
ssh ctpdrqm@192.168.31.66 "ls -la /vol1/1000/clash-full-storage/"
```

**如果不存在，手动创建：**
```bash
ssh ctpdrqm@192.168.31.66 << 'EOF'
mkdir -p /vol1/1000/clash-full-storage/{logs,backups,data,cache}
chmod 777 /vol1/1000/clash-full-storage/*
ls -la /vol1/1000/clash-full-storage/
EOF
```

---

## 🚦 后续步骤

### 立即执行（第一步）

```bash
# 1. 验证 SCP 可用性
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 \
  "echo 'test' > /tmp/t.txt && scp -o StrictHostKeyChecking=no -o ConnectTimeout=5 /tmp/t.txt ctpdrqm@192.168.31.66:/tmp/ && echo '✓ SCP 可用'"

# 2. 确认您知道路由器 root 密码
```

### 本周执行（第二步）

```bash
# 执行部署脚本
export ROUTER_PASSWORD="<password>"
export NAS_PASSWORD="cx@4343506"
./deploy_nas_log_transfer.sh
```

### 长期监控（第三步）

```bash
# 每天检查一次磁盘使用
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "df -h /data"

# 查看最近的转移日志
ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "tail -50 /tmp/nas_transfer.log"
```

---

## 💡 关键要点

✅ **保留本地日志**：脚本只保留最近 2 个日志，旧日志转移到 NAS
✅ **故障排查友好**：日志不会完全消失，只是转移到 NAS 进行长期保存
✅ **自动化运行**：通过 crontab 每 15 分钟自动执行
✅ **风险可控**：如果 NAS 不可达，脚本会自动使用本地清理方案

---

## 📞 需要帮助？

如果遇到问题，请检查：

1. 路由器 SSH 是否可用（HostKeyAlgorithms+ssh-rsa 兼容性）
2. NAS 是否在线（能 ping 到 192.168.31.66）
3. 路由器密码是否正确
4. 网络连接是否稳定

