// 游戏模式节点收敛：只保留香港、台湾、日本、韩国、新加坡五个低延迟地区的节点。
// 避免把其他远距离节点继续塞进游戏下拉列表和自动测速范围。

const GAME_REGION_KEYWORDS = [
  // 东亚
  '日本', 'japan', 'jp',
  '韩国', 'korea', 'kr',
  '台灣', '台湾', 'taiwan', 'tw',
  '香港', 'hongkong', 'hk',
  '新加坡', 'singapore', 'sg'
];

const GAME_TEST_URLS = {
    // 联机核心：实测 Nintendo 联机/中继入口，低流量、对丢包和 RTT 敏感。
    // NPLN 的 HTTPS 入口使用自签名证书，Mihomo delay 会 TLS 校验失败，改用 Switch 官方连接测试入口（HTTP 200）。
    match: 'http://conntest.nintendowifi.net/',
    // 下载核心：实测 Nintendo 游戏下载主要走 atum/veer/atum-5a8 等多个 d4c.srv.nintendo.net CDN，
    // 单目标测速会因 CDN 选点差异失真，改为多目标取最快（CDN 对匿名请求返回 403，但可测连通与 RTT）。
    // atum 的 HTTPS 同样有自签名证书问题，改用 HTTP 版本，Mihomo delay 可正常返回。
    download: [
        'http://atum.p01.lp1.d4c.srv.nintendo.net/',
        'http://veer.p01.lp1.d4c.srv.nintendo.net/',
        'http://atum-5a8.p01.lp1.d4c.srv.nintendo.net/'
    ],
    // 下载带宽：Cloudflare 官方 speed endpoint 提供可下载二进制，绕开 Nintendo CDN 的鉴权限制。
    downloadSpeed: 'https://speed.cloudflare.com/__down?bytes=10485760'
};

const { getGameNodeTag } = require('../../public/game-node-rules');

function getGameNodeTestUrls(nodeName) {
    return getGameNodeTag(nodeName) === '下载' ? GAME_TEST_URLS.download : [GAME_TEST_URLS.match];
}

function getGameNodeTestUrl(nodeName) {
    return getGameNodeTestUrls(nodeName)[0];
}

function isGameRegionNode(nodeName) {
  const lower = (nodeName || '').toLowerCase();
  return GAME_REGION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function filterGameRegionNodes(nodes) {
  return nodes.filter((node) => {
    const name = typeof node === 'string' ? node : node.name;
    return isGameRegionNode(name);
  });
}

module.exports = {
  GAME_REGION_KEYWORDS,
  GAME_TEST_URLS,
  isGameRegionNode,
  filterGameRegionNodes,
  getGameNodeTag,
  getGameNodeTestUrl,
  getGameNodeTestUrls
};
