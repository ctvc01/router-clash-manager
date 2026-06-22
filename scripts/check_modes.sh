#!/bin/sh

# ==============================================================================
# Script: check_modes.sh
# Description: Lightweight proxy connectivity & latency check tool (POSIX sh compatible)
# ==============================================================================

# 基础设置
ROUTER_IP="${ROUTER_IP:-192.168.31.1}"
# 优先使用代理端口 PROXY_PORT，避免被 Clash API 端口 CLASH_PORT (9999) 误导
CLASH_PORT="${PROXY_PORT:-${CLASH_PROXY_PORT:-7890}}"
PROXY_URL="http://${ROUTER_IP}:${CLASH_PORT}"

# ANSI 颜色定义
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_RED="\033[31m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_BLUE="\033[34m"
C_MAGENTA="\033[35m"
C_CYAN="\033[36m"

# 打印美化头部
echo "${C_CYAN}=====================================================${C_RESET}"
echo "${C_BOLD}${C_MAGENTA}   📡 Clash Meta Proxy Modes Checker${C_RESET}"
echo "${C_CYAN}=====================================================${C_RESET}"
echo "路由器网关: ${C_YELLOW}${ROUTER_IP}${C_RESET} | Clash 混合代理端口: ${C_YELLOW}${CLASH_PORT}${C_RESET}"
echo "检测执行时间 (UTC+8): ${C_BLUE}$(date -u -d '+8 hours' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')${C_RESET}"
echo "${C_CYAN}-----------------------------------------------------${C_RESET}"

# 状态检测主函数
# 参数: $1=模式名称, $2=测试站点, $3=是否使用代理(0/1)
check_connectivity() {
    local name="$1"
    local target="$2"
    local use_proxy="$3"
    
    local res
    local exit_code
    
    if [ "$use_proxy" -eq 1 ]; then
        res=$(curl -o /dev/null -s -w "%{http_code} %{time_total}" --connect-timeout 4 -x "${PROXY_URL}" "$target" 2>&1)
        exit_code=$?
    else
        res=$(curl -o /dev/null -s -w "%{http_code} %{time_total}" --connect-timeout 4 "$target" 2>&1)
        exit_code=$?
    fi
    
    # 提取结果
    local http_code
    http_code=$(echo "$res" | awk '{print $1}')
    local time_sec
    time_sec=$(echo "$res" | awk '{print $2}')
    
    # 容错：如果网络失败或连接重置，提取结果为空
    if [ $exit_code -ne 0 ] || [ -z "$http_code" ] || [ "$http_code" = "000" ]; then
        # 转换 curl exit code 为可读信息
        local err_msg="连接失败"
        [ $exit_code -eq 6 ] && err_msg="解析失败 (DNS Err)"
        [ $exit_code -eq 7 ] && err_msg="拒绝连接 (Refused)"
        [ $exit_code -eq 28 ] && err_msg="连接超时 (Timeout)"
        [ $exit_code -eq 35 ] && err_msg="握手失败 (SSL Err)"
        [ $exit_code -eq 52 ] && err_msg="无数据返回 (Empty)"
        [ $exit_code -eq 56 ] && err_msg="连接被重置 (Reset)"
        
        printf "  %-14s ➔ [ ${C_RED}❌ 无法访问${C_RESET} ] | 状态码: ${C_RED}---${C_RESET} | 延迟: ${C_RED}---${C_RESET} (${C_YELLOW}%s${C_RESET})\n" "$name" "$err_msg"
        return 1
    fi
    
    # 耗时转换为毫秒
    local time_ms
    time_ms=$(awk "BEGIN {print int($time_sec * 1000)}" 2>/dev/null || echo "0")
    if [ "$time_ms" = "0" ] && [ -n "$time_sec" ]; then
        # fallback
        time_ms=$(echo "$time_sec * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "---")
    fi
    
    # 评定状态码的健康程度 (比如 200, 301, 302, 204 是健康的；401, 404 表明连通但 API 鉴权/资源不存在)
    local status_color="${C_GREEN}"
    local label="正常连通"
    
    if [ "$http_code" -ge 400 ]; then
        if [ "$http_code" -lt 500 ]; then
            # 400~499 之间的状态码（包括 401 Unauthorized, 403 Forbidden, 404 Not Found 等）
            # 都意味着 TCP/TLS 握手已成功建立并收到了远端服务器/CDN 的应用层响应，说明网络完全通达。
            status_color="${C_GREEN}"
            label="正常连通"
        else
            status_color="${C_YELLOW}"
            label="服务端错"
        fi
    fi
    
    # 评定延迟健康度
    local delay_color="${C_GREEN}"
    if [ "$time_ms" != "---" ]; then
        if [ "$time_ms" -gt 600 ]; then
            delay_color="${C_RED}"
        elif [ "$time_ms" -gt 300 ]; then
            delay_color="${C_YELLOW}"
        fi
        time_ms="${time_ms} ms"
    fi
    
    printf "  %-14s ➔ [ ${status_color}✔ %s${C_RESET} ] | 状态码: ${status_color}%s${C_RESET} | 延迟: ${delay_color}%s${C_RESET}\n" \
        "$name" "$label" "$http_code" "$time_ms"
    return 0
}

# 任天堂游戏加速专项丢包与延迟测试
check_game_detail() {
    local target="http://ctest.cdn.nintendo.net"
    local count=5
    
    echo "${C_CYAN}-----------------------------------------------------${C_RESET}"
    echo "${C_BOLD}${C_MAGENTA}   🎮 Switch 游戏加速专项丢包与时延检测 (5次TCP采样)${C_RESET}"
    echo "${C_CYAN}-----------------------------------------------------${C_RESET}"
    echo "测试目标: ${C_YELLOW}${target}${C_RESET} | 采样包数: ${C_YELLOW}${count}${C_RESET}"
    
    local success_count=0
    local min_lat=99999
    local max_lat=0
    local sum_lat=0
    local loss_count=0
    
    local i=1
    while [ $i -le $count ]; do
        local res
        local exit_code
        # 记录 time_starttransfer (首字节耗时 / TTFB) 以真实反映经由代理节点往返任天堂主机的联机握手时延
        res=$(curl -o /dev/null -s -w "%{http_code} %{time_starttransfer}" --connect-timeout 3 -x "${PROXY_URL}" "$target" 2>&1)
        exit_code=$?
        
        local http_code
        http_code=$(echo "$res" | awk '{print $1}')
        local time_sec
        time_sec=$(echo "$res" | awk '{print $2}')
        
        if [ $exit_code -ne 0 ] || [ -z "$http_code" ] || [ "$http_code" = "000" ]; then
            loss_count=$((loss_count + 1))
            echo "  包 $i/$count: ${C_RED}❌ 超时/丢失${C_RESET}"
        else
            success_count=$((success_count + 1))
            local time_ms
            time_ms=$(awk "BEGIN {print int($time_sec * 1000)}" 2>/dev/null || echo "0")
            if [ "$time_ms" = "0" ] && [ -n "$time_sec" ]; then
                time_ms=$(echo "$time_sec * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "0")
            fi
            
            # 计算延迟
            sum_lat=$((sum_lat + time_ms))
            [ $time_ms -lt $min_lat ] && min_lat=$time_ms
            [ $time_ms -gt $max_lat ] && max_lat=$time_ms
            
            echo "  包 $i/$count: ${C_GREEN}✔ 正常${C_RESET} | HTTP-Code: ${C_GREEN}$http_code${C_RESET} | 时延: ${C_YELLOW}${time_ms} ms${C_RESET}"
        fi
        
        i=$((i + 1))
        # 每次采样间隔 200ms
        sleep 0.2
    done
    
    # 丢包率计算
    local loss_rate
    loss_rate=$(( loss_count * 100 / count ))
    
    local loss_color="${C_GREEN}"
    if [ $loss_rate -gt 40 ]; then
        loss_color="${C_RED}"
    elif [ $loss_rate -gt 0 ]; then
        loss_color="${C_YELLOW}"
    fi
    
    echo "${C_CYAN}-----------------------------------------------------${C_RESET}"
    echo "统计报告:"
    echo "  - 丢包率: ${loss_color}${loss_rate}%${C_RESET} (${success_count} 收到, ${loss_count} 丢失)"
    
    if [ $success_count -gt 0 ]; then
        local avg_lat
        avg_lat=$((sum_lat / success_count))
        
        local avg_color="${C_GREEN}"
        if [ $avg_lat -gt 400 ]; then
            avg_color="${C_RED}"
        elif [ $avg_lat -gt 150 ]; then
            avg_color="${C_YELLOW}"
        fi
        
        echo "  - 最短时延: ${C_GREEN}${min_lat} ms${C_RESET}"
        echo "  - 最长时延: ${C_RED}${max_lat} ms${C_RESET}"
        echo "  - 平均时延: ${avg_color}${avg_lat} ms${C_RESET}"
    else
        echo "  - 延迟指标: ${C_RED}无法计算 (链路已阻断)${C_RESET}"
    fi
}

# 依次执行检测
check_connectivity "DIRECT"   "https://www.baidu.com" 0
check_connectivity "PROXY"    "https://www.youtube.com" 1
check_connectivity "AI_BOOST"  "https://generativelanguage.googleapis.com" 1
check_connectivity "GAME"     "http://ctest.cdn.nintendo.net" 1

# 执行 Switch 专项深度联机测速与丢包检测
check_game_detail

echo "${C_CYAN}=====================================================${C_RESET}"
