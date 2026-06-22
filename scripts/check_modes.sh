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

# 依次执行检测
check_connectivity "DIRECT"   "https://www.baidu.com" 0
check_connectivity "PROXY"    "https://www.youtube.com" 1
check_connectivity "AI_BOOST"  "https://generativelanguage.googleapis.com" 1
check_connectivity "GAME"     "http://ctest.cdn.nintendo.net" 1

echo "${C_CYAN}=====================================================${C_RESET}"
