(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameNodeRules = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const EXPLICIT_DOWNLOAD_MARKERS = ['download', '下载'];
  const STRONG_MATCH_MARKERS = ['iplc', 'iepl', 'game', '游戏', '联机', '对战', '专线', '限速', '低延迟', '低延时'];
  const DIRECT_LINE_MARKERS = ['直連', '直连', '家寬', '家宽'];
  const DOWNLOAD_MARKERS = ['reality'];
  const DIRECT_DOWNLOAD_MARKERS = ['usa', 'united states', '美國', '美国', '美'];

  function getGameNodeTag(nodeName) {
    if (!nodeName) return '联机';
    const lower = nodeName.toLowerCase();
    if (EXPLICIT_DOWNLOAD_MARKERS.some((keyword) => lower.includes(keyword))) return '下载';
    // IPLC/IEPL/游戏/限速等联机特征优先于“直连/家宽”这类线路特征。
    if (STRONG_MATCH_MARKERS.some((keyword) => lower.includes(keyword))) return '联机';
    const isDirectLine = DIRECT_LINE_MARKERS.some((keyword) => lower.includes(keyword));
    const isReality = DOWNLOAD_MARKERS.some((keyword) => lower.includes(keyword));
    const isHomeBand = lower.includes('家寬') || lower.includes('家宽');
    const isGRPC = lower.includes('grpc');
    // 只有直连+gRPC、没有家宽/Reality 时保守标记为联机，避免把纯 gRPC 落地误判成下载。
    if (isDirectLine && isGRPC && !isHomeBand && !isReality) return '联机';
    if (isDirectLine || isReality) return '下载';
    if (isGRPC) return '联机';
    if (DIRECT_DOWNLOAD_MARKERS.some((keyword) => lower.includes(keyword))) return '下载';
    return '联机';
  }

  return { getGameNodeTag };
});
