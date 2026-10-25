# 架构与实现细节

## 1. 数据流

```
应用
 ├─ 走环境变量代理（Claude Code / Codex / curl）→ 127.0.0.1:7897 → mihomo
 └─ 走系统 TUN（浏览器等）→ utun1024 → mihomo
```

mihomo 收到连接后：
1. 域名/IP 匹配规则（`rules` 自上而下）；
2. 命中 `🤖 AI 出口` 时：fallback 组只有 `🇺🇸 美国静态IP` → 该 socks5 节点的 `dialer-proxy = ⛓️ 链式前置` → 先经机场节点建立到静态代理的隧道 → 再做 SOCKS5 握手 → 出口 = 美国静态 IP；
3. 命中机场组时：select 组 → `自动选择`（url-test，香港/台湾已排除）→ 延迟最低节点；
4. 命中 DIRECT/GEOIP,CN → 物理网卡直出。

## 2. 关键设计

### 2.1 链式代理（chain proxy）

- **为什么**：国内直连美国静态 IP 时好时坏（GFW 对固定 IP 的干扰是全局性的，跟本地出口无关）；机场节点做前置可稳定中转。
- **实现**：`socks5` 节点 + `dialer-proxy: ⛓️ 链式前置`。这是 mihomo 唯一支持的链式机制（`relay` 组类型已在新版移除）。
- **健康检查**：前置组 url-test 的探测 URL = `http://<静态代理IP>:<端口>/`，`expected-status: '407'`。只有"能连到静态代理端口"的节点才算健康，**Hysteria 类节点虽然能上网，但承载不了这条 TCP 隧道，会被自动排除**。
- **每台机器自己选**：前置池相同，url-test 各自测速，不同机器会选到不同节点——只要最终出口是同一个美国静态 IP 即可。

### 2.2 fail-closed

- AI 组是 **fallback 且只有一个成员**：链路异常时连接直接失败，不会回落到机场共享 IP。
- 规则表首行 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT`：全局拦截 QUIC，防止应用用 HTTP/3 绕过域名规则。
- 规则表顶部另有三条 STUN 拦截（`19302` / `3478` / `5349`）：防止 WebRTC 向 STUN 服务器探测时把真实公网 IP 从 DIRECT 链路泄漏出去（详见 README 4.1 与 TROUBLESHOOTING 第 6 节）。
- 兜底 `MATCH` 指向机场组（不是 DIRECT），IPv6/杂项流量也不会直连泄漏。
- 环境变量层再兜一层（`~/.claude/settings.json` + `~/.zshrc`）。

### 2.3 DNS

```
dns:
  default-nameserver:      [223.5.5.5, 119.29.29.29, 114.114.114.114]   # 传统 UDP
  proxy-server-nameserver: [223.5.5.5, 119.29.29.29, system]            # 解析节点域名
  nameserver:              [223.5.5.5#DIRECT, 119.29.29.29#DIRECT, https://doh.pub/dns-query#DIRECT]
  enhanced-mode: fake-ip  # 198.18.0.0/16
```

- **不要用 DoH 作为唯一上游**：部分网络下 DoH 会全部超时，导致节点域名/ECH 配置解析失败（详见 TROUBLESHOOTING）。
- `fake-ip-filter` 放行本地域名，保证真实解析。

### 2.4 港台节点过滤

- 只过滤**自动型组**（url-test / fallback / load-balance），select 组保留全部节点供手动选择。
- 识别规则：节点名含 `香港`/`HK`、`台湾`/`台灣`/`台北`/`新北`/`台中`/`高雄`、对应旗帜 emoji，以及订阅的「剩余流量/套餐到期」等信息节点。

### 2.5 netguard（网络自愈）

- 每 30s 探测国内 DoH 锚点（`223.5.5.5:443`、`119.29.29.29:443`）。
- 连续 3 次失败 → 抓现场快照（路由/DNS/进程/日志尾）→ 自动重启 Clash Verge → 复查。
- 处理"换 Wi-Fi/换子网后 Clash 没重新接管 DNS/路由"的经典抽风（TUN 模式特有）。

## 3. 规则优先级设计原则

1. **安全相关（AI 出口、QUIC 拦截）放最前**，任何订阅自带规则都不能覆盖；
2. **订阅自带规则居中**（视频、广告拦截）；
3. **GEOIP,CN → DIRECT**，最后 `MATCH → 机场组`。

## 4. 订阅适配

同一套覆写文件被两个订阅共用，脚本在运行时按订阅自带的组做适配：

| 场景 | 行为 |
|---|---|
| 订阅有 `🧱 GFW` 组（校园机场） | 改成 url-test 自动测速（排除 `[v6]`/HK-/TW-），把 `🚀 Accel.` 规则改指 `🧱 GFW`，`MATCH,DIRECT` → `MATCH,🧱 GFW` |
| 订阅无 `🧱 GFW` 组（商业机场） | 跳过上述美化，链式组仍会创建；`MATCH` 保持订阅自带的机场组 |
| 通用 | 注入静态 IP 节点、AI 出口组与 AI 规则、DNS 兜底、港台过滤 |
