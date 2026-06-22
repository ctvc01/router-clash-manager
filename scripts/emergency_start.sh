#!/bin/sh
# 最小化 ShellCrash 启动脚本
# 在路由器无法从 GitHub 下载时使用此脚本直接启动
# 使用方法：sh /data/ShellCrash/emergency_start.sh

CRASHDIR=/data/ShellCrash
LOGFILE=$CRASHDIR/run.log

# 检查配置文件
if [ ! -f "$CRASHDIR/yamls/config.yaml" ]; then
    echo "[$(date)] ❌ 错误: 配置文件不存在 $CRASHDIR/yamls/config.yaml" >> $LOGFILE
    exit 1
fi

# 创建必要的目录
mkdir -p $CRASHDIR/configs 2>/dev/null

# 清除启动锁定
rm -f $CRASHDIR/.start_error 2>/dev/null

# 获取 Clash 内核路径（多个可能的位置）
CLASH_BIN=""
for path in /data/ClashMeta/Clash /tmp/ClashMeta/Clash /data/Clash /tmp/Clash /data/ShellCrash/ClashCore /data/ShellCrash/Clash; do
    if [ -x "$path" ]; then
        CLASH_BIN="$path"
        break
    fi
done

# 如果找不到预装的二进制，尝试使用 busybox 或其他工具
if [ -z "$CLASH_BIN" ]; then
    echo "[$(date)] ⚠️ 未找到 Clash 二进制文件" >> $LOGFILE
    echo "[$(date)] 可用的选项：" >> $LOGFILE
    echo "[$(date)] 1. 从 OpenWrt 应用商店安装 ShellCrash" >> $LOGFILE
    echo "[$(date)] 2. 手动上传 Clash 内核到 $CRASHDIR/" >> $LOGFILE
    exit 1
fi

echo "[$(date)] 🚀 启动 Clash 核心: $CLASH_BIN" >> $LOGFILE

# 启动 Clash
$CLASH_BIN -d $CRASHDIR -f $CRASHDIR/yamls/config.yaml </dev/null >/dev/null 2>>$LOGFILE &

# 等待启动
sleep 2

# 检查是否启动成功
if pidof $(basename $CLASH_BIN) >/dev/null 2>&1; then
    echo "[$(date)] ✅ Clash 核心已启动成功" >> $LOGFILE
else
    echo "[$(date)] ❌ Clash 核心启动失败" >> $LOGFILE
    exit 1
fi
