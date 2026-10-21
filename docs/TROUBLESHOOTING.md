# 故障排查手册

> 症状 → 原因 → 处理。最后附 2026-10-21「链式代理全部失败」的完整复盘。

## 快速自查

```bash
scutil --dns | head -20                       # 系统 DNS
pgrep -fl verge-mihomo                        # Clash 内核
tail -30 ~/Library/Logs/netguard.log
```

---

## 常见症状

### 1. 换 Wi-Fi / 换子网后所有应用都没网，但网络本身是通的

- **原因**：Clash Verge 的 TUN 模式在网络切换后没有重新接管 DNS/路由（系统代理模式没有这个问题）。
- **处理**：重启 Clash 内核即可（**不用重启电脑**）。`netguard` 会在连续 3 次探测失败后自动执行。
- **验证**：`netguard.log` 里出现"连续失败 → 自动重启 Clash Verge"。

### 2. AI（Claude / ChatGPT）时通时不通

```bash
curl -x http://127.0.0.1:7897 -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' https://api.anthropic.com/
```

- `404` = 正常（Anthropic 根路径返回 404）；
- `000` = 链路失败：看 Clash 日志里 `dial 🤖 AI 出口 ... error:` 的具体原因；
- 检查 `⛓️ 链式前置` 组的当前节点是否健康：健康检查必须测"节点→静态代理端口返回 407"；
- 检查 DNS（见故障 5）。**千万不要把 ECH 配置剥掉**——那是节点规避 SNI 阻断的手段。

### 3. 外网自动选到了香港/台湾节点

- 规则：`自动选择`/`故障转移` 组由脚本过滤，名称含 `香港`/`HK`/`台湾`/`台北`/`TW` 及订阅信息节点的会被剔除；
- 验证：`/proxies/自动选择` 的成员列表应无港台；
- 手动选择不受限（机场 select 组保留全部节点）。

### 4. 节点域名解析失败 / ECH 解析失败（链式必挂）

典型日志：

```
resolve ECH config error: all DNS resolvers failed
... connect error: <node>:443 connect error: dns resolve failed: couldn't find ip
re-creating the http client due to requesting https://223.5.5.5:443/dns-query: context deadline exceeded
```

- **原因**：订阅的 DNS 只配了 DoH，而当前网络下 DoH 全部超时；
- **处理**：`script.js` 的 `fixDns()` 已把 DNS 改为传统 UDP + `system`（见 README 第二节第 1 条）；
- **注意**：修好 DNS 后 **保留** 节点的 `ech-opts`（ECH 能规避 SNI 阻断；剥掉反而连不上）。

### 5. 链式代理报 503/504、AI 000（超时 5 秒）

按可能性排序：

| 可能原因 | 验证方法 | 处理 |
|---|---|---|
| DNS/ECH 解析失败 | 见故障 4 的日志关键字 | 修 DNS，保留 ECH |
| 健康检查 URL 错误导致所有节点被判死 | `/proxies/⛓️ 链式前置` 的成员 history 全为 `delay: 0` | 健康检查改为 `http://<静态代理IP>:<端口>/` + `expected-status: 407` |
| 选中了 Hysteria 节点 | 该节点单独测速正常，但静态代理延迟测试超时 | 健康检查会把它排除；不要用通用 204 探测 |
| 节点是纯 IPv6 | 节点 server 是 `2605:...` 等 IPv6 地址 | 本机有公网 IPv6 才能用；否则换 IPv4 节点 |
| 静态代理服务端白名单/限流 | 经节点访问静态代理端口，返回 407 才算通 | 联系服务商或换前置节点 |

---

## 附：2026-10-21 链式代理排查复盘

**现象**：同一订阅、同一份配置、同一内核版本，一台机器链式正常，另一台全部失败（AI 000、健康检查 503/504）。

**根因链**：

1. 订阅的 DNS 只配了 DoH（223.5.5.5 / doh.pub / dns.alidns.com），当前网络下全部超时；
2. 机场美国节点是 Cloudflare + VLESS + TLS + **ECH**，拨号前必须查 DNS 取 ECH 配置；
3. 能用的那台机器有 DNS 缓存且失败快速降级 → 节点照常拨通；
   另一台每次冷启动缓存为空，ECH 查询挂起到超时 → 拨号直接报 `resolve ECH config error`；
4. 表现为"所有节点健康检查全死"，url-test 卡在第一个死节点上。

**排除项**：

| 假设 | 结论 |
|---|---|
| 版本问题（应用 2.4.7 vs 2.5.8 / 内核 1.19.21 vs 1.19.32） | 升级后症状不变，排除 |
| 覆写文件差异 | 两端 hash 完全一致，排除 |
| `relay` 组机制 | 新版内核已移除该类型（"请改用 dialer-proxy"），排除 |
| 节点本身不能连静态代理 | 经节点访问静态代理端口返回 407，通路正常 |
| 剥离 ECH | 反向错误：剥掉后暴露 SNI，更连不上 |

**修复**（现已写入 `script.js`）：

1. `fixDns()`：DNS 改传统 UDP + `system`，不再依赖 DoH；
2. 保留 ECH；
3. 前置组健康检查 = `节点 → 静态代理端口 → 407`，自动排除 Hysteria 与不可用节点。

**最终状态**：两台机器的 AI 出口 = 同一美国静态 IP；外网自动选路排除港台。
