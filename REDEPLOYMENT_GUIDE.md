# 容器重新部署指南

## 当前状态
- ✅ Clash 进程：运行正常 (PID 7857)
- ✅ 代理端口 7890：监听中
- ✅ 代理连接测试：通过

## 需要重新部署的原因
刚刚修复了 `src/routes/gateway.js` 中的一个关键问题：

**问题**：网关状态检测端点检查错误的进程名
- 原代码查找：`CrashCore`
- 实际运行：`Clash` (PID 7857)
- **结果**：控制面板无法正确检测到网关在线状态，显示"加载中"

**修复**：
- 提交 `35ec7f0` 更新了进程检测逻辑
- 现在检查顺序：`Clash` → `CrashCore` → `pgrep`

## 部署步骤（在 NAS 上执行）

### 选项 A：快速重新部署（推荐）
```bash
# 1. SSH 连接到 NAS
ssh -l admin 192.168.1.1  # 或你的 NAS IP

# 2. 进入项目目录
cd /vol1/1000/router-clash-manager

# 3. 从 GitHub 拉取最新代码
git pull origin main

# 4. 重建并重新启动容器
docker-compose down
docker-compose up -d --build

# 5. 验证
docker-compose ps
curl -s http://localhost:3000/api/gateway/status | jq .
```

### 选项 B：通过 NAS Web UI（如果可用）
1. 打开 NAS 控制面板 (http://NAS-IP:5000)
2. 进入 Docker 应用
3. 找到 `clash-meta` 容器
4. 点击"清理并重建"或"更新"

### 选项 C：部分重新启动容器（如果不需要重建镜像）
```bash
cd /vol1/1000/router-clash-manager
git pull origin main
docker-compose restart
```

## 验证重新部署成功

重新部署后，检查以下内容：

```bash
# 1. 容器健康状态
docker-compose ps

# 2. 网关在线状态 API
curl -s http://localhost:3000/api/gateway/status | jq '.running'
# 期望输出：true

# 3. 控制面板
在浏览器中打开：http://dev.jinjitu.com:3000
控制面板应显示网关在线状态（不再是"加载中"）
```

## 关键改动

**文件**：`src/routes/gateway.js` (第 69 行)

修改前：
```javascript
const pidOutput = await SshService.runRemoteCommand('pidof CrashCore || pgrep -f CrashCore');
```

修改后：
```javascript
const pidOutput = await SshService.runRemoteCommand('pidof Clash || pidof CrashCore || pgrep -f "CrashCore|clash"');
```

## 注意事项

- 确保 NAS 上已安装 Docker 和 docker-compose
- 确保网络连接稳定（重建镜像可能需要拉取依赖）
- 重新启动后，容器启动通常需要 10-30 秒

## 快速故障排查

| 问题 | 原因 | 解决方案 |
|------|------|--------|
| 容器启动失败 | 端口被占用 | 检查 `docker ps` 并清理旧容器 |
| 控制面板仍显示"加载中" | 容器缓存未刷新 | 清除浏览器缓存，Ctrl+F5 刷新 |
| 无法 Git pull | 网络问题 | 检查 NAS 网络连接和 GitHub 访问 |
| 进程检测仍失败 | 代码未更新 | 确保执行了 `git pull` 和 `docker-compose up -d --build` |

## 完成后

重新部署完成后：
- ✅ 控制面板应显示网关"在线"
- ✅ 网关状态信息（内存、CPU、版本等）应正常显示
- ✅ 所有设备分流功能应恢复正常

---

**上次部署**：提交 `35ec7f0`  
**部署者**：Claude Haiku 4.5
