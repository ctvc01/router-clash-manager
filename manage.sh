#!/usr/bin/env bash

# ==============================================================================
# Script: manage.sh
# Description: Local management tool for ShellCrash on router (192.168.31.1)
# ==============================================================================

# 基础设置
ROUTER_IP="${ROUTER_IP:-192.168.31.1}"
API_PORT="${API_PORT:-9999}"
BASE_URL="http://${ROUTER_IP}:${API_PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ANSI 颜色定义
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_RED="\033[31m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_BLUE="\033[34m"
C_MAGENTA="\033[35m"
C_CYAN="\033[36m"
C_WHITE="\033[37m"

# 打印美化横幅
print_banner() {
    echo -e "${C_CYAN}=====================================================${C_RESET}"
    echo -e "${C_BOLD}${C_MAGENTA}   🛰️  Clash Meta Local Manager${C_RESET}"
    echo -e "${C_CYAN}=====================================================${C_RESET}"
}

# 远程执行并清洗输出（提取标记之间的真实内容）
run_remote_clean() {
    local cmd="$1"
    local raw_output
    # 使用分号确保即使命令失败，结束标记也能打印出来
    raw_output=$(expect "${SCRIPT_DIR}/run_remote.exp" "echo '===START===' ; $cmd ; echo '===END==='" 2>/dev/null)
    
    # 提取 ===START=== 和 ===END=== 之间的行，并清除 \r
    echo "$raw_output" | awk '/===START===/{flag=1;next}/===END===/{flag=0}flag' | tr -d '\r'
}

# 格式化输出状态
show_status() {
    echo -e "\n${C_BOLD}${C_BLUE}[*] 正在查询路由器 Clash 服务状态...${C_RESET}"
    
    # 1. 检查远程进程
    local remote_pid
    remote_pid=$(run_remote_clean "pidof CrashCore")
    # 去除多余空格和换行
    local pid
    pid=$(echo "$remote_pid" | tr -d '[:space:]')

    if [ -n "$pid" ] && echo "$pid" | grep -qE '^[0-9]+$'; then
        # 运行中，获取占用内存
        local mem_info
        mem_info=$(run_remote_clean "cat /proc/${pid}/status | grep VmRSS")
        local mem
        mem=$(echo "$mem_info" | grep -oE 'VmRSS:.*' | awk '{print $2 " " $3}')
        [ -z "$mem" ] && mem="未知"

        echo -e "${C_BOLD}● 服务状态:${C_RESET} ${C_GREEN}● 正在运行 (Active)${C_RESET}"
        echo -e "${C_BOLD}● 核心 PID:${C_RESET} ${C_CYAN}${pid}${C_RESET}"
        echo -e "${C_BOLD}● 内存占用:${C_RESET} ${C_YELLOW}${mem}${C_RESET}"

        # 2. 尝试读取 REST API 信息
        local api_version
        api_version=$(curl -s --connect-timeout 2 "${BASE_URL}/version")
        if [ $? -eq 0 ] && [ -n "$api_version" ]; then
            local version
            version=$(echo "$api_version" | jq -r '.version // "未知"')
            local is_meta
            is_meta=$(echo "$api_version" | jq -r '.meta // "false"')
            local core_type="Clash"
            [ "$is_meta" = "true" ] && core_type="Mihomo (Clash Meta)"

            local api_configs
            api_configs=$(curl -s "${BASE_URL}/configs")
            local mode
            mode=$(echo "$api_configs" | jq -r '.mode // "未知"')
            local allow_lan
            allow_lan=$(echo "$api_configs" | jq -r '."allow-lan" // "false"')

            echo -e "${C_BOLD}● 内核版本:${C_RESET} ${C_MAGENTA}${version} (${core_type})${C_RESET}"
            echo -e "${C_BOLD}● 代理模式:${C_RESET} ${C_GREEN}${mode}${C_RESET}"
            echo -e "${C_BOLD}● 允许局域网:${C_RESET} ${C_CYAN}${allow_lan}${C_RESET}"
            echo -e "${C_BOLD}● Web UI 面板:${C_RESET} ${C_WHITE}http://${ROUTER_IP}:${API_PORT}/ui/${C_RESET}"
        else
            echo -e "${C_BOLD}● API 状态:${C_RESET} ${C_RED}无法连接 (REST API 未响应)${C_RESET}"
        fi
    else
        echo -e "${C_BOLD}● 服务状态:${C_RESET} ${C_RED}○ 已停止 (Inactive)${C_RESET}"
    fi
    echo ""
}

# 动作：启动
action_start() {
    echo -e "${C_GREEN}[+] 正在尝试启动路由器 Clash 服务...${C_RESET}"
    run_remote_clean "/data/ShellCrash/start.sh start" >/dev/null
    sleep 2
    show_status
}

# 动作：停止
action_stop() {
    echo -e "${C_RED}[-] 正在尝试停止路由器 Clash 服务...${C_RESET}"
    run_remote_clean "/data/ShellCrash/start.sh stop" >/dev/null
    sleep 2
    show_status
}

# 动作：重启
action_restart() {
    echo -e "${C_YELLOW}[#] 正在尝试重启路由器 Clash 服务...${C_RESET}"
    run_remote_clean "/data/ShellCrash/start.sh restart" >/dev/null
    sleep 2
    show_status
}

# 动作：更新订阅与节点
action_update() {
    echo -e "${C_MAGENTA}[↑] 正在拉取最新的 Clash 订阅节点并重新应用...${C_RESET}"
    echo -e "${C_WHITE}(正在通过路由器 curl 绕过 TLS 证书阻断，请稍候...)${C_RESET}"
    
    # 远程执行：提取 url、使用 curl 下载并覆盖缓存，随后重启
    local update_res
    update_res=$(run_remote_clean "sh -c 'URL=\$(grep -A 2 \"caomei1:\" /data/ShellCrash/yamls/config.yaml | grep \"url:\" | cut -d \"\\\"\" -f 2) && echo \"获取到订阅链接: \$URL\" && curl -k -L -s -o /data/ShellCrash/providers/caomei1.yaml \"\$URL\" && echo \"[OK] 节点拉取成功，大小: \$(wc -c < /data/ShellCrash/providers/caomei1.yaml) 字节\" && echo \"正在重启服务...\" && /data/ShellCrash/start.sh restart'")
    echo -e "${C_WHITE}${update_res}${C_RESET}"
    
    sleep 3
    show_status
}

# 动作：获取代理选择列表
action_proxies() {
    echo -e "\n${C_BOLD}${C_CYAN}┌─── 策略组选择状态 ────────────────────────────────────────────────────────┐${C_RESET}"
    
    local proxies_json
    proxies_json=$(curl -s --connect-timeout 3 "${BASE_URL}/proxies")
    if [ $? -ne 0 ] || [ -z "$proxies_json" ]; then
        echo -e "  ${C_RED}错误: 无法获取代理策略组列表，请检查 Clash 是否正常启动且 REST API 可用。${C_RESET}"
        echo -e "${C_BOLD}${C_CYAN}└───────────────────────────────────────────────────────────────────────────┘${C_RESET}"
        return 1
    fi

    # 使用 jq 美化打印选择器策略组和其当前选中的节点
    echo "$proxies_json" | jq -r '
        .proxies | to_entries[] | 
        select(.value.type == "Selector") | 
        "  \u001b[1m\u001b[32m" + .key + "\u001b[0m ➔ \u001b[33m" + .value.now + "\u001b[0m"
    ' | while read -r line; do
        printf "  %-120s\n" "$line"
    done
    echo -e "${C_BOLD}${C_CYAN}└───────────────────────────────────────────────────────────────────────────┘${C_RESET}\n"
}

# 动作：流式查看实时日志
action_logs() {
    echo -e "${C_YELLOW}[!] 正在连接 Clash 日志流。按 [Ctrl+C] 退出日志查看...${C_RESET}\n"
    
    # 捕获 Ctrl+C 并优雅退出
    trap "echo -e '\n${C_GREEN}[*] 已退出日志查看。${C_RESET}'; exit 0" INT
    
    # 使用 curl 流式读取并将 json 转换输出
    curl -s -N "${BASE_URL}/logs" | jq --unbuffered -R -r '
        rtrimstr("\r") | 
        try (
            fromjson | 
            if .type == "info" then 
                "\u001b[32m[INFO]\u001b[0m \(.payload)" 
            elif .type == "warning" then 
                "\u001b[33m[WARN]\u001b[0m \(.payload)" 
            elif .type == "error" then 
                "\u001b[31m[ERR ]\u001b[0m \(.payload)" 
            else 
                "\u001b[35m[\(.type | ascii_upcase)]\u001b[0m \(.payload)" 
            end
        ) catch .
    '
}

# 动作：进入交互式菜单
action_menu() {
    echo -e "${C_CYAN}[->] 正在通过 SSH 连接并打开 ShellCrash 交互菜单...${C_RESET}"
    expect "${SCRIPT_DIR}/run_interactive.exp"
}

# 动作：帮助文档
show_help() {
    print_banner
    echo -e "使用方法:"
    echo -e "  $0 <command>\n"
    echo -e "可用命令 (Commands):"
    echo -e "  ${C_GREEN}status${C_RESET}     - 查看路由器 Clash 服务的当前状态与运行内核信息"
    echo -e "  ${C_GREEN}start${C_RESET}      - 启动路由器上的 Clash 代理服务"
    echo -e "  ${C_GREEN}stop${C_RESET}       - 停止路由器上的 Clash 代理服务"
    echo -e "  ${C_GREEN}restart${C_RESET}    - 重启路由器上的 Clash 代理服务"
    echo -e "  ${C_GREEN}update${C_RESET}     - 在路由器上更新节点订阅与配置，并自动重启应用"
    echo -e "  ${C_GREEN}proxies${C_RESET}    - 列出当前所有代理策略组的节点选择状态"
    echo -e "  ${C_GREEN}logs${C_RESET}       - 实时流式监控和查看 Clash 的请求分流日志 (彩色)"
    echo -e "  ${C_GREEN}menu${C_RESET}       - 登录路由器直接运行 ShellCrash 原生交互菜单"
    echo -e "  ${C_GREEN}help${C_RESET}       - 显示本帮助文档"
    echo ""
}

# 主控制分支
case "$1" in
    status)
        print_banner
        show_status
        ;;
    start)
        print_banner
        action_start
        ;;
    stop)
        print_banner
        action_stop
        ;;
    restart)
        print_banner
        action_restart
        ;;
    update)
        print_banner
        action_update
        ;;
    proxies|proxy)
        print_banner
        action_proxies
        ;;
    logs|log)
        print_banner
        action_logs
        ;;
    menu)
        action_menu
        ;;
    help|*)
        show_help
        ;;
esac
