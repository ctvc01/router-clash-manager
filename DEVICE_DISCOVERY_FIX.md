---
name: 设备卡片显示修复完成
description: 解决 http://192.168.31.66:3000 设备卡片显示为空的问题
type: project
---

## ✅ 已解决的问题

### 设备卡片无法显示根本原因
**问题**：容器中的代码尝试读取 `/tmp/dhcp.leases`，但 Xiaomi 路由器上此文件不存在
**影响**：前端页面设备卡片显示为空

### 解决方案
1. **双模式设备发现**
   - 优先使用 DHCP 租约文件（标准格式）
   - 如果不可用，自动降级使用 ARP 表
   - 代码正确解析两种格式

2. **在路由器上部署辅助脚本**
   ```bash
   /tmp/generate_dhcp_leases.sh  # 动态生成 DHCP 租约文件
   ```
   - 每 5 分钟通过 cron 自动执行一次
   - 生成标准格式：`timestamp mac ip hostname *`
   - 输出到 `/tmp/dhcp.leases`

3. **自定义设备名称持久化**
   - ✅ 已验证：自定义名称保存成功
   - ✅ 存储位置：NAS `/vol1/1000/router-clash-manager/device_custom.json`
   - ✅ 接口：POST `/api/devices/custom` 保存，GET `/api/devices` 返回

---

## 📊 当前功能状态

### 设备发现
```
✅ 发现设备数量：40+ 局域网设备
✅ 设备信息：MAC 地址、IP、hostname
✅ 自定义名称：可设置并持久化
✅ 设备分类：支持 pc/phone/tablet/game/tv/iot/other
```

### 实时数据显示
```
✅ 设备 MAC：正常显示
✅ 设备 IP：正常显示  
✅ 设备 hostname：显示"未知设备"（因为 DHCP 租约中无名称）
⚠️ 实时流量（rx_rate/tx_rate）：显示为 0（ubus trafficd 不可用）
```

### API 端点
```
GET  /api/devices         # 获取设备列表（含自定义名称）
POST /api/devices/custom  # 保存设备自定义名称和分类
```

---

## 🔧 部署的内容

### 在路由器上
```
/tmp/generate_dhcp_leases.sh  # 生成 DHCP 租约文件的脚本
/tmp/dhcp.leases             # 生成的 DHCP 租约文件（每 5 分钟更新）

Crontab 任务：
*/5 * * * * /tmp/generate_dhcp_leases.sh > /tmp/dhcp.leases 2>&1
```

### 在 NAS 容器中
```
/app/src/routes/devices.js   # 支持 DHCP 租约和 ARP 双模式的设备发现
/vol1/1000/router-clash-manager/device_custom.json  # 自定义名称存储
```

---

## 📋 现在设备卡片显示的内容

每个设备卡片包含：
```json
{
  "mac": "c0:84:ff:c5:da:f8",
  "ip": "192.168.31.57",
  "hostname": "未知设备",      // 可通过自定义名称覆盖
  "rx_rate": 0,                // 下行流量（单位：byte/s）
  "tx_rate": 0                 // 上行流量（单位：byte/s）
}
```

前端会：
1. 显示自定义名称（如果有）
2. 显示 MAC、IP、hostname
3. 显示实时流量（如果 ubus 可用）
4. 允许用户编辑名称和分类

---

## ⚠️ 已知限制和改进空间

### 1. Hostname 显示为"未知设备"
**原因**：路由器的 DHCP 租约文件中，设备 hostname 列为 `*`（未记录）

**可能原因**：
- Xiaomi 路由器未配置记录设备 hostname
- DHCP 服务器未收到 hostname 信息

**解决方案**：
- 方案 A：用户可通过自定义名称功能设置设备名称（已可用）
- 方案 B：从其他来源获取 hostname（需额外配置）

### 2. 实时流量显示为 0
**原因**：`ubus call trafficd hw` 在该路由器上不可用

**可能原因**：
- trafficd 服务未运行或未安装
- ubus 权限问题（SSH 访问的 ubus 限制）

**验证命令**：
```bash
ssh root@192.168.31.1 "ubus call trafficd hw"
# 结果：Failed to connect to ubus
```

**解决方案**：
- 方案 A：在路由器上启用并配置 trafficd 服务
- 方案 B：使用其他流量查询方式（如 tc，已验证 tc 命令可用）
- 方案 C：接受当前显示为 0 的状态

---

## 📝 测试结果

### API 测试
```bash
# 获取设备列表
curl http://192.168.31.66:3000/api/devices
# 返回：40 个设备，包含自定义名称

# 保存自定义名称
curl -X POST http://192.168.31.66:3000/api/devices/custom \
  -H "Content-Type: application/json" \
  -d '{"mac":"c0:84:ff:c5:da:f8","name":"Office PC","category":"pc"}'
# 返回：{"success": true}

# 验证保存
curl http://192.168.31.66:3000/api/devices | jq '.custom'
# 返回：包含新保存的自定义名称
```

---

## 🎯 前端预期功能

用户在 http://192.168.31.66:3000 上应该能看到：

1. **设备卡片**
   - 显示 40+ 设备
   - 每个设备显示：名称、MAC、IP、流量

2. **自定义设备**
   - 点击设备卡片可编辑名称
   - 可选择设备类型（pc/phone/tablet 等）
   - 改动会自动保存

3. **实时更新**
   - 设备列表每 15 秒缓存刷新一次
   - DHCP 租约文件每 5 分钟更新一次

---

## 🚀 后续可选优化

### 高优先级
- [ ] 启用 trafficd 服务以获取实时流量
- [ ] 改进 DHCP 租约中的 hostname 数据收集

### 中优先级
- [ ] 从 dnsmasq 日志解析真实设备名称
- [ ] 集成设备 MAC 地址查询库获取制造商信息
- [ ] 增加设备图标和自定义 emoji

### 低优先级  
- [ ] 设备发现历史记录
- [ ] 设备分组功能
- [ ] 流量统计趋势

---

**修复完成时间**: 2026-06-19 17:35  
**功能状态**: ✅ 设备卡片可以正常显示  
**自定义名称**: ✅ 可保存和持久化  
**待改进**: ⚠️ hostname 和实时流量（需额外配置）
