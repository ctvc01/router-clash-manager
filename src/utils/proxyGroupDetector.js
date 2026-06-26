const Logger = require('../utils/logger');

class ProxyGroupDetector {
    // 候选代理组名称（按优先级排序）
    static PROXY_GROUP_CANDIDATES = [
        '🚀 选择节点',
        '🚀 节点选择',
        '🌍 选择代理',
        'GLOBAL',
        'Proxy',
        '代理选择',
        '节点选择',
        '策略组',
        'select',
        'Select',
        'PROXY'
    ];

    // 从所有代理组中找出最可能是主代理组的一个
    static findMainProxyGroup(proxies) {
        if (!proxies || typeof proxies !== 'object') {
            return null;
        }

        // 首先尝试硬编码的候选名称
        // 注：Clash Meta的type是 "Selector" 或 "select"，需要不区分大小写或兼容两种
        for (const name of this.PROXY_GROUP_CANDIDATES) {
            const group = proxies[name];
            if (group && this._isSelectType(group.type) && group.now) {
                Logger.debug('ProxyGroupDetector', `Found proxy group by name: ${name}`);
                return { name, group };
            }
        }

        // 如果没有找到，扫描所有select类型的代理组，找出可选节点最多的
        let maxNodesGroup = null;
        let maxNodeCount = 0;

        for (const [name, group] of Object.entries(proxies)) {
            if (group && this._isSelectType(group.type) && group.all && Array.isArray(group.all)) {
                const nodeCount = group.all.length;
                if (nodeCount > maxNodeCount && nodeCount > 2) {
                    // 跳过系统代理组
                    if (!['⚡ 游戏自动测速', '⚡ AI自动测速', 'DIRECT'].includes(name)) {
                        maxNodesGroup = { name, group };
                        maxNodeCount = nodeCount;
                    }
                }
            }
        }

        if (maxNodesGroup) {
            Logger.debug('ProxyGroupDetector', `Found main proxy group by node count: ${maxNodesGroup.name} (${maxNodeCount} nodes)`);
            return maxNodesGroup;
        }

        return null;
    }

    // 检查type是否为select类型（兼容 select 和 Selector）
    static _isSelectType(type) {
        if (!type) return false;
        const lowerType = typeof type === 'string' ? type.toLowerCase() : '';
        return lowerType === 'select' || lowerType === 'selector';
    }

    // 递归获取物理节点（处理代理组嵌套）
    static getRealPhysicalNode(proxies, nodeName, visited = new Set()) {
        if (!nodeName || !proxies) {
            return { name: nodeName || 'UNKNOWN', delay: 0 };
        }

        if (visited.has(nodeName)) {
            return { name: nodeName, delay: 0 };
        }
        visited.add(nodeName);

        const node = proxies[nodeName];
        if (!node) {
            return { name: nodeName, delay: 0 };
        }

        // 如果是代理组，递归查找当前节点
        if (node.now && typeof node.now === 'string' && proxies[node.now]) {
            return this.getRealPhysicalNode(proxies, node.now, visited);
        }

        // 获取最后一次有效测试的延迟
        let delay = 0;
        if (node.history && Array.isArray(node.history) && node.history.length > 0) {
            // 优先取最后一条非0延迟记录，否则取最后一条记录
            const validDelays = node.history.filter(h => h.delay > 0);
            if (validDelays.length > 0) {
                delay = validDelays[validDelays.length - 1].delay;
            } else if (node.history.length > 0) {
                // 如果都是0延迟，取最后一条（可能还在测试中）
                delay = node.history[node.history.length - 1].delay;
            }
        }

        return { name: nodeName, delay };
    }
}

module.exports = ProxyGroupDetector;
