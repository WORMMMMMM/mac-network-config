// Clash Verge 扩展脚本：把 🧱 GFW 组改成自动测速组，实现节点故障自动切换
//
// 背景：订阅自带的 🧱 GFW 是 select（手动选择）组，节点挂了（例如 US-T1）
// 不会自动切换，必须手动改，表现为「什么都没动突然连不上」。
// 放到扩展脚本里而不是直接改订阅文件，是为了订阅更新后依然生效。
//
// 排除项说明：
//   1. [v6] —— IPv6 节点。url-test 按「延迟最低」选，而 IPv6 节点测速总是赢
//      （约 80ms，IPv4 要 200ms+），所以会被自动选中。但校园网 IPv6 的状态
//      防火墙会清掉闲置长连接：curl 这类短请求没事，ChatGPT 依赖的 WebSocket
//      会反复断开重连，表现为「一直转圈连不上」。实测同样走 [v6] 节点时，
//      10MB 下载正常，但 ws.chatgpt.com 在 5 分钟内重连了 3 次。
//   2. HK- —— 香港延迟最低（约 50ms）会被优先选中，但 OpenAI 不向香港提供服务，
//      会让 ChatGPT 报「地区不可用」。
//   3. TW- —— 按使用要求排除。
//
// 匹配规则说明：不能只匹配国旗 emoji。香港节点名形如 `🇭🇰 HK-G1`，但台湾节点
// 没有国旗，名字直接是 `TW-V1`；IPv6 节点形如 `🇸🇬 [v6]SG-U1`。
// 所以统一用「地区代码 + 短横线」和「[v6]」标记做匹配，不会误伤 US/JP/SG/NL/DE。

// 注意：下面匹配时会先把节点名转成大写，所以这里的模式也必须大写，
// 否则 '[v6]' 匹配不上被转成大写的 '[V6]'（踩过这个坑）。
var EXCLUDE = ['[V6]', 'HK-', 'TW-'];

// ===== 外网自动选路：排除香港 / 台湾 / 订阅信息节点（2026-10-21）=====
// 用户要求：直连外网（YouTube 等）自动用"最快且非港台"的节点。
// 只过滤自动型组（url-test / fallback / load-balance），select 组保留全部节点供手动选择。
var INFO_PATTERNS = ['剩余流量', '距离下次重置', '套餐到期', '若无法使用', '官网', '通知', '过期', '更新订阅'];
function isExcludedNode(name) {
  var n = String(name == null ? '' : name);
  var up = n.toUpperCase();
  for (var i = 0; i < INFO_PATTERNS.length; i++) {
    if (n.indexOf(INFO_PATTERNS[i]) >= 0) return true;
  }
  // 香港
  if (n.indexOf('香港') >= 0 || n.indexOf('\uD83C\uDDED\uD83C\uDDF0') >= 0) return true;
  if (/(^|[^A-Z])HK([^A-Z]|$)/.test(up)) return true;
  // 台湾
  if (/台湾|台灣|台北|新北|台中|高雄|桃园|桃園/.test(n)) return true;
  if (n.indexOf('\uD83C\uDDF9\uD83C\uDDFC') >= 0) return true;
  if (/(^|[^A-Z])TW([^A-Z]|$)/.test(up)) return true;
  return false;
}
function filterAutoGroups(config) {
  var groups = config['proxy-groups'];
  if (!Array.isArray(groups)) return config;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g) continue;
    if (g.type !== 'url-test' && g.type !== 'fallback' && g.type !== 'load-balance') continue;
    if (g.name === FRONT_GROUP) continue; // 链式前置池本来就是美国节点
    if (!Array.isArray(g.proxies)) continue;
    var kept = g.proxies.filter(function (n) { return !isExcludedNode(n); });
    if (kept.length) g.proxies = kept;
  }
  return config;
}

// ===== 外网自动选路：排除香港 / 台湾 / 订阅信息节点（结束）=====

function main(config, profileName) {
  injectStaticNode(config);
  fixDns(config);
  routeAiThroughStatic(config);

  var groups = config['proxy-groups'];
  if (!groups || !groups.length) return config;

  var gfw = groups.find(function (g) {
    return g && g.name === '🧱 GFW';
  });
  if (!gfw) {
    // 新订阅无「🧱 GFW」组：跳过 GFW 组美化，但链式组仍要建（2026-10-21 修复）
    buildFrontGroup(config);
    filterAutoGroups(config);
    return config;
  }

  if (Array.isArray(gfw.proxies)) {
    var kept = gfw.proxies.filter(function (name) {
      var upper = String(name).toUpperCase();
      return !EXCLUDE.some(function (code) {
        return upper.indexOf(String(code).toUpperCase()) >= 0;
      });
    });
    if (kept.length) gfw.proxies = kept;
  }

  gfw.type = 'url-test';
  gfw.url = gfw.url || 'http://cp.cloudflare.com/';
  gfw.interval = 300;   // 测速间隔（秒）
  gfw.tolerance = 50;   // 延迟差小于 50ms 就不切换，避免频繁抖动
  gfw.timeout = 3000;

  buildFrontGroup(config);
  filterAutoGroups(config);

  return config;
}

// ===== 自购美国静态IP（2026-10 添加）=====
// 节点：科罗拉多 Centennial（Colocation America，AS6079 RCN），
// 适合「需要固定美国 IP」的场景；已开启链式中转（见文件末尾 buildFrontGroup），
// 实际路径 = 机场前置节点 → 本节点 → 目标，国内直连本节点的慢/丢包问题由中转解决。
// 未开启 udp（上个节点实测 SOCKS5 UDP 转发不稳定），浏览器 QUIC 会自动回落 TCP，不影响使用。
var STATIC_NODE = {
  name: '🇺🇸 美国静态IP',
  type: 'socks5',
  server: '198.51.100.10',  // ← 换成你自己的静态代理 IP
  port: 5782,
  username: 'YOUR_USERNAME',
  password: 'YOUR_PASSWORD',
};

function injectStaticNode(config) {
  var proxies = config['proxies'];
  if (!Array.isArray(proxies)) {
    proxies = [];
    config['proxies'] = proxies;
  }
  var exists = false;
  for (var i = 0; i < proxies.length; i++) {
    if (proxies[i] && proxies[i].name === STATIC_NODE.name) {
      exists = true;
      break;
    }
  }
  if (!exists) {
    proxies.push(STATIC_NODE);
  }

  var groups = config['proxy-groups'];
  if (Array.isArray(groups)) {
    for (var j = 0; j < groups.length; j++) {
      var g = groups[j];
      if (g && g.name === '🚀 Accel.' && Array.isArray(g.proxies) && g.proxies.indexOf(STATIC_NODE.name) < 0) {
        g.proxies.push(STATIC_NODE.name);
      }
    }
  }
  return config;
}

// ===== AI / 美区账号 流量出口（2026-10 调整）=====
// 目的：ChatGPT / Claude / Gemini 相关流量 + Google 注册/登录/账号管理域名，
// 固定走自购美国静态IP（保持出口IP一致，维护「美区账号」身份）；
// 其他所有外网流量继续走 🧱 GFW 自动测速池，国内直连不受影响。
// 做法：
//   1) 订阅规则里 AI 相关的 9 条 + 补充域名（AI 辅助域名、Google 账号域名）改指到
//      「🤖 AI 出口」组；
//   2) 兜底规则 IP-CIDR,0.0.0.0/0（原指 🚀 Accel.）改指到 🧱 GFW，即「其他都走GFW」；
//      MATCH,DIRECT 也改成 MATCH,🧱 GFW（IPv6 与杂项兜底不再回落直连）；
//   3) 「🤖 AI 出口」是 fallback 组：[静态IP → 🧱 GFW]，全自动：
//      链路健康时走静态IP；链路断则 AI 流量直接失败（宁可断网，fail-closed）。
//      不放 DIRECT 兜底——两条链路都挂时宁可断网，也不回落直连暴露中国 IP（防封原则）。
// 注意：匹配用「关键字 + 完整域名后缀」两级，避免像 voaindonesia.com 这种
// 含 'oai' 但无关的域名被误伤。
var AI_GROUP = '🤖 AI 出口';
var AI_KEYWORDS = ['openai', 'chatgpt', 'claude', 'anthropic', 'gemini'];
var AI_DOMAINS = ['oaiusercontent.com', 'oaistatic.com', 'claudeusercontent.com', 'sora.com', 'aistudio.google.com'];
var AI_EXTRA_RULES = [
  'DOMAIN-SUFFIX,oaistatic.com',
  'DOMAIN-SUFFIX,claudeusercontent.com',
  'DOMAIN-SUFFIX,aistudio.google.com',
];
// Google 注册/登录/账号管理域名：固定走同一个静态IP（美区身份一致性）。
// 只加账号相关域名，不影响 Google 搜索 / YouTube 日常速度。
var GOOGLE_ACCOUNT_RULES = [
  'DOMAIN-SUFFIX,accounts.google.com',
  'DOMAIN-SUFFIX,myaccount.google.com',
  'DOMAIN-SUFFIX,account.google.com',
  'DOMAIN-SUFFIX,accounts.youtube.com',
  'DOMAIN-SUFFIX,oauth2.googleapis.com',
];
// QUIC（UDP 443）拦截：静态IP节点不支持 UDP，按 mihomo 规则「UDP 无支持则继续向下匹配」
// 的行为，QUIC 流量会一路漏到直连（实测 Claude 桌面端的 QUIC 从中国 IP 直连了！）。
// 在最顶部 REJECT 掉所有 UDP:443，让 App/浏览器强制回落 TCP（会被正常代理由规则接管）。
// 微信/游戏等非 443 UDP 不受影响；校园 VPN（UDP 51820）也不受影响。
var QUIC_BLOCK_RULES = ['AND,((NETWORK,UDP),(DST-PORT,443)),REJECT'];

function isAiPayload(payload) {
  for (var i = 0; i < AI_KEYWORDS.length; i++) {
    if (payload.indexOf(AI_KEYWORDS[i]) >= 0) return true;
  }
  for (var j = 0; j < AI_DOMAINS.length; j++) {
    var d = AI_DOMAINS[j];
    if (payload === d || payload.slice(-(d.length + 1)) === '.' + d) return true;
  }
  return false;
}

function routeAiThroughStatic(config) {
  var rules = config['rules'];
  if (Array.isArray(rules)) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (typeof rule !== 'string') continue;

      // 兜底防泄漏：MATCH,DIRECT → MATCH,🧱 GFW（IPv6/杂项流量不再回落直连，
      // 宁可断网也不从中国 IP 出去——参考防封教程的「断网不直连」原则）
      var matchParts = rule.split(',');
      if (matchParts.length === 2 && matchParts[0].trim().toUpperCase() === 'MATCH' && matchParts[1].trim().toUpperCase() === 'DIRECT') {
        rules[i] = 'MATCH,🧱 GFW';
        continue;
      }

      // 出口是最后一个字段；IP-CIDR 类规则末尾可能带 no-resolve
      var parts = rule.split(',');
      var idx = parts.length - 1;
      var tail = parts[idx].trim();
      if (tail === 'no-resolve' || tail === 'src') idx = idx - 1;
      if (idx < 2) continue;

      var target = parts[idx].trim();
      if (target !== '🧱 GFW' && target !== '🚀 Accel.') continue;

      var payload = parts.slice(1, idx).join(',').toLowerCase();
      if (isAiPayload(payload)) {
        parts[idx] = AI_GROUP;
      } else if (target === '🚀 Accel.') {
        parts[idx] = '🧱 GFW';
      } else {
        continue;
      }
      rules[i] = parts.join(',');
    }

    // 顶部前置规则（最终顺序）：QUIC 拦截（完整规则）→ AI 辅助域名 → Google 账号域名。
    // 域名类是"片段"（需要拼 ,🤖 AI 出口），QUIC 是完整规则（原样插入）。
    var inserts = [];
    for (var q = 0; q < QUIC_BLOCK_RULES.length; q++) {
      inserts.push({ text: QUIC_BLOCK_RULES[q], probe: QUIC_BLOCK_RULES[q] });
    }
    var frags = AI_EXTRA_RULES.concat(GOOGLE_ACCOUNT_RULES);
    for (var k2 = 0; k2 < frags.length; k2++) {
      inserts.push({ text: frags[k2] + ',' + AI_GROUP, probe: frags[k2] + ',' });
    }
    for (var t = inserts.length - 1; t >= 0; t--) {
      var exists = false;
      for (var m = 0; m < rules.length; m++) {
        if (typeof rules[m] === 'string' && rules[m].indexOf(inserts[t].probe) === 0) {
          exists = true;
          break;
        }
      }
      if (!exists) rules.unshift(inserts[t].text);
    }
  }

  var groups = config['proxy-groups'];
  if (Array.isArray(groups)) {
    var aiGroup = null;
    for (var g = 0; g < groups.length; g++) {
      if (groups[g] && groups[g].name === AI_GROUP) {
        aiGroup = groups[g];
        break;
      }
    }
    if (!aiGroup) {
      aiGroup = { name: AI_GROUP };
      groups.push(aiGroup);
    }
    // fail-closed 收紧（2026-10-11）：只走静态IP；链路断 = AI 流量直接失败（宁可断网），
    // 不切机场共享IP（保持美区账号出口 IP 一致性）；不放 DIRECT、不放 🧱 GFW 兜底。
    aiGroup.type = 'fallback';
    aiGroup.proxies = [STATIC_NODE.name];
    aiGroup.url = aiGroup.url || 'http://cp.cloudflare.com/';
    aiGroup.interval = 120;
    aiGroup.timeout = 3000;
  }
  return config;
}

// ===== 链式中转 + 自动测速（2026-10 调整）=====
// 背景：国内直连境外机房经常很慢/丢包；机场节点走优质出口（CN2 等），国内连它们快、稳。
// 路径：你的设备 → 机场节点(前置，自动测速) → 静态IP(落地) → 目标网站。
// 「⛓️ 链式前置」：url-test 自动测速组，只在「美国 + 近期实测能连通静态IP」的节点里
// 自动挑最快的（美国节点离静态IP最近；JP/SG 中转要多绕 100-300ms，而且部分节点
// 连不上静态IP的 5782 端口，不能进池）。选中的节点掉了/变慢会自动换下一个。
// 注意：节点可用性会随时间变化（实测 10-06 可用的节点 10-09 就变了），
// FRONT_PREFERRED 是「最近一次实测可用」名单，入池时与当前订阅求交集；
// 交集为空则退化为全部 US 节点、再退化为全部节点，保证配置永远可用。
var FRONT_GROUP = '⛓️ 链式前置';
// 2026-10-09 实测：US-P1 穿链路稳定性差（3/5 通过，两次超时），且自动测速老选它
// （它直连测速快但穿链路最差）——从池中移除，只留 5/5 稳定的三个。
var FRONT_PREFERRED = [];  // 不再钉死节点：靠"节点→静态IP"健康检查(407)自动排除连不上的节点

// 2026-10-21：DoH 全部超时 → 节点域名/ECH(HTTPS RR) 解析失败 → 链式挂。
function fixDns(config) {
  var d = config.dns || (config.dns = {});
  d.enable = true;
  d['default-nameserver'] = ['223.5.5.5', '119.29.29.29', '114.114.114.114'];
  d['proxy-server-nameserver'] = ['223.5.5.5', '119.29.29.29', 'system'];
  d.nameserver = ['223.5.5.5#DIRECT', '119.29.29.29#DIRECT', 'https://doh.pub/dns-query#DIRECT'];
  return config;
}

function buildFrontGroup(config) {
  var groups = config['proxy-groups'];
  if (!Array.isArray(groups)) {
    delete STATIC_NODE['dialer-proxy'];
    return config;
  }

  var gfw = null;
  // 2026-10-21：新订阅（机场主组）没有「🧱 GFW」组，链式前置改为按候选组名查找
  var FRONT_SOURCES = ['🧱 GFW', '自动选择', '机场主组', '节点选择', 'Proxy'];
  for (var c = 0; c < FRONT_SOURCES.length && !gfw; c++) {
    for (var i = 0; i < groups.length; i++) {
      if (groups[i] && groups[i].name === FRONT_SOURCES[c]) {
        gfw = groups[i];
        break;
      }
    }
  }
  var available = gfw && Array.isArray(gfw.proxies) ? gfw.proxies.slice() : [];
  // 过滤订阅里的信息伪装节点（剩余流量/到期时间等）
  var INFO_WORDS = ['剩余流量', '距离下次', '重置', '到期', '套餐', '官网', '流量：', '点击'];
  available = available.filter(function (n) {
    var t = String(n);
    for (var w = 0; w < INFO_WORDS.length; w++) {
      if (t.indexOf(INFO_WORDS[w]) >= 0) return false;
    }
    return true;
  });

  var pool = [];
  for (var p = 0; p < available.length; p++) {
    if (FRONT_PREFERRED.indexOf(String(available[p])) >= 0) pool.push(available[p]);
  }
  if (!pool.length) {
    for (var u = 0; u < available.length; u++) {
      var nm = String(available[u]);
      // 美国节点优先（美国节点连静态IP的 5782 最稳；2026-10-21 增加中文"美国"匹配）
      if (nm.indexOf('US-') >= 0 || nm.indexOf('美国') >= 0) pool.push(available[u]);
    }
  }
  if (!pool.length) pool = available;
  if (!pool.length) {
    delete STATIC_NODE['dialer-proxy'];
    return config;
  }

  var front = null;
  for (var j = 0; j < groups.length; j++) {
    if (groups[j] && groups[j].name === FRONT_GROUP) {
      front = groups[j];
      break;
    }
  }
  if (!front) {
    front = { name: FRONT_GROUP };
    groups.push(front);
  }
  front.type = 'url-test';
  // 2026-10-21：健康检查直指静态IP本身（它返回 407=代理应答），
  // 只有真正能连到静态IP的节点才算健康——彻底避免"快但连不上静态IP"的节点被选中。
  // 2026-10-21：健康检查专测"节点→静态IP:5782"（SOCKS5 返回 407 即通），
  // 这样 url-test 只会选中能承载链式的节点（Hysteria 节点虽然能上网，但带不动链式，会被自动排除）。
  front.url = 'http://' + STATIC_NODE.server + ':' + STATIC_NODE.port + '/';
  front['expected-status'] = '407';
  front.interval = 120;
  front.tolerance = 50;
  front.timeout = 5000;
  front.proxies = pool;

  // 2026-10-21 恢复链式中转：静态IP直连已失效（国内直连超时），AI 流量改回经机场节点中转。
  // 代价：AI 流量重新计入机场额度（2026-10-20 曾因省额度关闭过）。
  STATIC_NODE['dialer-proxy'] = FRONT_GROUP;
  return config;
}
