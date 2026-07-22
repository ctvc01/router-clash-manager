#!/bin/sh
# 故障根原因分析脚本
# 在路由器上执行：bash this_script.sh
# 或从 NAS 容器执行：docker exec clash-meta bash this_script.sh

set -e

echo "=========================================="
echo "🔍 Clash 服务中断根原因诊断"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""

# ===== 1. 磁盘空间检查 =====
echo "📊 [1/8] 磁盘空间分析"
echo "---"
df -h /data / | awk 'NR==1 {print "  " $0} NR>1 {printf "  %-20s %8s %8s %8s %6s\n", $6, $2, $3, $4, $5}'

# 检查是否满载
USAGE=$(df /data 2>/dev/null | tail -1 | awk '{print $5}' | sed 's/%//' || echo "0")
if [ "$USAGE" -gt 80 ]; then
    echo "  ⚠️  /data 使用率 ${USAGE}% (>80% - 可能是故障原因!)"
elif [ "$USAGE" -gt 90 ]; then
    echo "  🔴 /data 使用率 ${USAGE}% (>90% - 严重!)"
else
    echo "  ✅ /data 使用率 ${USAGE}% (正常)"
fi
echo ""

# ===== 2. 最大文件检查 =====
echo "📁 [2/8] 大文件排查"
echo "---"
echo "  最大的 10 个文件:"
find /data -type f -size +10M 2>/dev/null | xargs ls -lh 2>/dev/null | awk '{print "    " $9 " (" $5 ")"}' | head -10 || echo "    (无大文件或路径不可访问)"
echo ""

# ===== 3. Clash 进程状态 =====
echo "⚙️  [3/8] Clash 进程状态"
echo "---"
if ps -ef | grep -v grep | grep -q 'Clash' 2>/dev/null; then
    echo "  ✅ Clash 进程运行中"
    ps aux | grep -i clash | grep -v grep | awk '{print "    PID=" $2 ", CPU=" $3"%, MEM=" $4"%"}'

    # 获取进程启动时间
    CLASH_PID=$(ps -ef | grep -v grep | grep 'Clash' | awk 'NR==1{print \$1}')
    START_TIME=$(ps -p $CLASH_PID -o lstart= 2>/dev/null || echo "unknown")
    echo "    启动时间: $START_TIME"
else
    echo "  ❌ Clash 进程未运行"
    if [ -f /data/ShellCrash/.start_error ]; then
        echo "  ⚠️  检测到启动错误标记: .start_error"
    fi
fi
echo ""

# ===== 4. Clash 日志分析 =====
echo "📝 [4/8] Clash 日志检查"
echo "---"
if [ -f /data/ShellCrash/run.log ]; then
    LOGSIZE=$(wc -l < /data/ShellCrash/run.log)
    echo "  日志行数: $LOGSIZE"

    # 查找错误
    ERROR_COUNT=$(grep -ic "error\|panic\|fatal\|failed" /data/ShellCrash/run.log || echo "0")
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo "  🔴 发现 $ERROR_COUNT 条错误信息"
        echo "  最近的错误:"
        grep -i "error\|panic\|fatal\|failed" /data/ShellCrash/run.log | tail -5 | sed 's/^/    /'
    else
        echo "  ✅ 无明显错误"
    fi

    # 查看最后 10 行
    echo ""
    echo "  最后 10 行日志:"
    tail -10 /data/ShellCrash/run.log | sed 's/^/    /'
else
    echo "  ❌ 日志文件不存在: /data/ShellCrash/run.log"
fi
echo ""

# ===== 5. 启动错误标记 =====
echo "🚨 [5/8] 启动故障标记检查"
echo "---"
if [ -f /data/ShellCrash/.start_error ]; then
    echo "  🔴 存在 .start_error 文件（启动失败标记）"
    ls -la /data/ShellCrash/.start_error
    echo "  创建时间: $(stat -c '%y' /data/ShellCrash/.start_error 2>/dev/null || echo 'unknown')"
else
    echo "  ✅ 无启动错误标记"
fi
echo ""

# ===== 6. 配置文件完整性 =====
echo "⚙️  [6/8] 配置文件检查"
echo "---"
if [ -f /data/ShellCrash/yamls/config.yaml ]; then
    CONF_SIZE=$(wc -c < /data/ShellCrash/yamls/config.yaml)
    echo "  ✅ 配置文件存在 ($CONF_SIZE 字节)"

    # 检查配置完整性
    if ! grep -q "^port:" /data/ShellCrash/yamls/config.yaml; then
        echo "  ⚠️  配置可能不完整（未找到 port 字段）"
    fi

    # 检查是否为有效 YAML
    if command -v python3 >/dev/null 2>&1; then
        if python3 -c "import yaml; yaml.safe_load(open('/data/ShellCrash/yamls/config.yaml'))" 2>/dev/null; then
            echo "  ✅ YAML 格式有效"
        else
            echo "  🔴 YAML 格式错误（配置文件损坏!）"
        fi
    fi
else
    echo "  ❌ 配置文件不存在"
fi
echo ""

# ===== 7. 系统内存检查 =====
echo "💾 [7/8] 系统内存状态"
echo "---"
if [ -f /proc/meminfo ]; then
    MEMTOTAL=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    MEMFREE=$(awk '/MemFree/ {print $2}' /proc/meminfo)
    MEMUSED=$((MEMTOTAL - MEMFREE))
    MEMPERCENT=$((MEMUSED * 100 / MEMTOTAL))
    echo "  总内存: $((MEMTOTAL/1024)) MB"
    echo "  已用: $((MEMUSED/1024)) MB"
    echo "  空闲: $((MEMFREE/1024)) MB"
    echo "  使用率: ${MEMPERCENT}%"

    if [ "$MEMPERCENT" -gt 85 ]; then
        echo "  ⚠️  内存使用率较高，可能导致 OOM"
    fi
else
    echo "  (Linux 系统信息不可用)"
fi
echo ""

# ===== 8. 最近的系统事件 =====
echo "📋 [8/8] 系统事件日志"
echo "---"
if command -v dmesg >/dev/null 2>&1; then
    # 查找 OOM killer 相关的日志
    OOM_EVENTS=$(dmesg | grep -c "Out of memory" || echo "0")
    if [ "$OOM_EVENTS" -gt 0 ]; then
        echo "  🔴 检测到 OOM killer 事件 ($OOM_EVENTS 次)"
        dmesg | grep "Out of memory" | tail -3 | sed 's/^/    /'
    else
        echo "  ✅ 无 OOM killer 事件"
    fi

    # 查找进程被杀的日志
    KILL_EVENTS=$(dmesg | grep -c "Killed process\|killed\|segmentation" || echo "0")
    if [ "$KILL_EVENTS" -gt 0 ]; then
        echo "  ⚠️  检测到进程被杀事件 ($KILL_EVENTS 次)"
        dmesg | grep -i "killed\|segmentation" | tail -3 | sed 's/^/    /'
    fi
else
    echo "  (dmesg 不可用)"
fi
echo ""

# ===== 故障判断 =====
echo "=========================================="
echo "🎯 初步诊断结论"
echo "=========================================="

VERDICT=""

if [ "$USAGE" -gt 80 ]; then
    VERDICT="${VERDICT}1. 🔴 磁盘满载 (${USAGE}%) - 极可能导致 Clash 崩溃\n"
fi

ERROR_COUNT=$(grep -ic "error\|panic\|fatal" /data/ShellCrash/run.log 2>/dev/null || echo "0")
if [ "$ERROR_COUNT" -gt 10 ]; then
    VERDICT="${VERDICT}2. 🔴 大量错误日志 ($ERROR_COUNT 条) - 表明应用问题\n"
fi

if [ -f /data/ShellCrash/.start_error ]; then
    VERDICT="${VERDICT}3. 🟡 启动失败标记存在 - 需要检查启动条件\n"
fi

if ! ps -ef | grep -v grep | grep -q 'Clash' 2>/dev/null; then
    VERDICT="${VERDICT}4. 🔴 Clash 目前不运行 - 需要立即重启\n"
fi

if [ -z "$VERDICT" ]; then
    echo "✅ 所有检查点正常，故障可能已经自愈或需要进一步调查"
else
    printf "%s\n" "$VERDICT"
fi

echo ""
echo "=========================================="
echo "✅ 诊断完成"
echo "=========================================="
