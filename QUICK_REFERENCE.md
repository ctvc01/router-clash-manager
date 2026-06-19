# ⚡ NAS 日志分流 - 快速参考卡

## 🔑 关键凭证（已保存）

```
路由器: root@192.168.31.1 (90c747a2)
NAS:    ctpdrqm@192.168.31.66 (cx@4343506)
```

## 📊 最常用命令

### 查看实时转移状态
```bash
tail -f /tmp/log_sync.log
```

### 检查路由器磁盘
```bash
sshpass -p "90c747a2" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "df -h /data"
```

### 查看 NAS 上有多少个日志文件
```bash
sshpass -p "cx@4343506" ssh -o StrictHostKeyChecking=no ctpdrqm@192.168.31.66 "ls -1 /vol1/1000/clash-full-storage/logs | wc -l"
```

### 查看 Clash 是否运行
```bash
sshpass -p "90c747a2" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "ps | grep -i clash | grep -v grep"
```

## 🔧 维护命令

### 手动立即执行转移
```bash
cd /Users/cheng/Projects/router-clash-manager
bash sync_logs_periodic.sh
```

### 查看 Crontab 任务
```bash
crontab -l | grep sync_logs
```

### 暂停自动转移（如需调试）
```bash
crontab -l | grep -v sync_logs | crontab -
```

### 恢复自动转移
```bash
(crontab -l 2>/dev/null | grep -v sync_logs; \
echo "*/15 * * * * bash /Users/cheng/Projects/router-clash-manager/sync_logs_periodic.sh 2>&1 >> /tmp/log_sync.log") | crontab -
```

## 📈 性能指标

| 指标 | 当前值 | 预期目标 |
|------|--------|---------|
| /data 使用率 | 91% | 80-85% |
| 本地日志数 | 1 | 1-2 |
| NAS 日志数 | 1+ | 不限 |
| Clash 进程 | ✅ 运行 | ✅ 运行 |

## 🎯 工作原理

```
每 15 分钟自动执行：
1. 清理路由器旧日志（>7天）
2. 从路由器拉取日志到本地
3. 转移到 NAS
4. 检查磁盘使用率
```

## ❓ 常见问题

### Q: 日志没有转移，怎么办？
```bash
# 查看错误日志
tail -50 /tmp/log_sync.log
```

### Q: 需要查看路由器上的原始日志？
```bash
# 本地保留了最近的日志
sshpass -p "90c747a2" ssh -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa root@192.168.31.1 "cat /data/ShellCrash/ShellCrash.log | tail -100"
```

### Q: NAS 上的日志存在多久？
```bash
# 无限期保存，可按需清理
sshpass -p "cx@4343506" ssh -o StrictHostKeyChecking=no ctpdrqm@192.168.31.66 "du -sh /vol1/1000/clash-full-storage/"
```

## 📝 文件位置

```
项目目录: /Users/cheng/Projects/router-clash-manager/
├── sync_logs_periodic.sh           ← 定时转移脚本
├── DEPLOYMENT_SUMMARY.md           ← 完整总结
├── NAS_LOG_DISTRIBUTION_GUIDE.md   ← 详细指南
└── DEPLOYMENT_READY.md             ← 快速开始

路由器:
└── /data/clean_logs.sh             ← 清理脚本

NAS:
└── /vol1/1000/clash-full-storage/
    ├── logs/                       ← 日志存储
    ├── backups/                    ← 配置备份
    └── data/                       ← 其他数据
```

## ✅ 部署验收清单

- [x] 路由器清理脚本已部署
- [x] 本地转移脚本已创建
- [x] Crontab 任务已配置
- [x] NAS 存储已准备
- [x] 首次转移已执行
- [x] 凭证已保存到内存
- [x] 监控命令已测试

---

**部署时间**：2026-06-19 16:50  
**部署者**：Claude Code  
**版本**：1.0

