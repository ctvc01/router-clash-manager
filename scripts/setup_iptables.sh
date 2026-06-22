#!/bin/sh
# 透明代理 iptables 重建脚本
# 安全重建：先删除旧 REDIRECT 规则，再重建，确保幂等

WHITELIST="/data/ShellCrash/configs/mac"
REDIR_PORT="7892"

# 0. 清理旧的自定义链（如果存在）
iptables -t nat -D PREROUTING -j CLASH_PRE 2>/dev/null
iptables -t nat -F CLASH_PRE 2>/dev/null
iptables -t nat -X CLASH_PRE 2>/dev/null

# 1. 删除旧的 REDIRECT 规则（仅删除我们创建的，不碰系统规则）
iptables -t nat -D PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null
# 循环删除直到没有匹配（因为 -D 一次只删一条）
while iptables -t nat -C PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null; do
    iptables -t nat -D PREROUTING -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null
done

# 2. 确保 ESTABLISHED,RELATED 逃逸规则在最前面（防止转发流被重复劫持）
#    检查是否存在，不存在则插入到最前面
iptables -t nat -C PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || iptables -t nat -I PREROUTING -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# 3. 读取白名单，为每个 MAC 创建 TCP REDIRECT 规则
if [ -f "$WHITELIST" ]; then
    while read mac; do
        [ -z "$mac" ] && continue
        echo "$mac" | grep -q '^#' && continue
        mac=$(echo "$mac" | tr 'a-z' 'A-Z')
        # 检查规则是否已存在，不存在则添加
        iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT" 2>/dev/null \
            || iptables -t nat -A PREROUTING -m mac --mac-source "$mac" -p tcp -j REDIRECT --to-ports "$REDIR_PORT"
    done < "$WHITELIST"
fi

RULE_COUNT=$(iptables -t nat -L PREROUTING -n 2>/dev/null | grep -c "redir ports $REDIR_PORT" || echo 0)
echo "iptables: $RULE_COUNT TCP REDIRECT rules in PREROUTING"
