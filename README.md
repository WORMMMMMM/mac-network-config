# Mac 网络配置（Clash Verge TUN + 链式静态 IP）

本仓库是 Mac 上「科学上网」配置的可复现归档：Clash Verge 的扩展脚本、规则、分组模板、网络自愈服务，以及踩过的坑。

> **所有凭据均已脱敏**：静态代理的账号密码、订阅 URL、节点信息全部替换为占位符。复现时替换成你自己的即可。

---

## 一、架构

```
                            ┌──────────────── 应用层 ────────────────┐
                            │ Claude Code / Codex / 浏览器 / CLI 工具  │
                            └───────┬───────────────────┬────────────┘
                    环境变量代理(可选) │                   │ 系统 TUN
                                    ▼                   ▼
┌─────────────────────────────── Clash Verge (TUN) ───────────────────────────────┐
│  utun1024, fake-ip 198.18.0.0/16                                                │
│                                                                                 │
│  🤖 AI 出口 (fallback，仅 1 个成员 = fail-closed)                                │
│     └─ 🇺🇸 美国静态IP (socks5) ──dialer-proxy──▶ ⛓️ 链式前置 (url-test)          │
│                                    │               └─ 机场节点（自动选可用）    │
│                                    ▼                                            │
│                          <静态代理> ──▶ Anthropic / OpenAI                       │
│                                                                                 │
│  其他外网 ──▶ 机场主组 (select) ──▶ 自动选择 (url-test，排除香港/台湾) ──▶ 节点   │
│  国内 ──▶ DIRECT                                                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、配置清单

### 1. 系统网络层

| 项目 | 值 |
|---|---|
| 代理工作模式 | **TUN 模式**（系统代理关闭），TUN 网卡 `utun1024`，stack = gvisor，MTU 1500 |
| 假 IP 段 | `198.18.0.0/16`（IPv4）、`fdfe:dcba:9876::1/64`（IPv6） |
| DNS | mihomo 内置 DNS（`dns-hijack: any:53`），使用**传统 UDP 上游**（不用 DoH） |
| 分流路由 | `0/1`、`128/1` → TUN；国内/私有网段由更具体的系统路由直出 |

### 2. Clash Verge

- **版本**：2.5.8，内核 mihomo v1.19.32（`verge-mihomo`，非 alpha）
- **订阅**：两个 profile（主用商业机场 / 备用校园机场），各自独立记住节点选择
- **覆写文件**（两个 profile 共用同一套，脚本按订阅自带组自动适配）：
  - `clash/script.js` — 核心扩展脚本
  - `clash/rules.yaml` — AI 规则
  - `clash/merge.yaml` — DNS / fake-ip 基础配置
  - `clash/proxies-template.yaml`、`clash/groups-template.yaml` — 空模板（占位）

### 3. 代理分组

| 组 | 类型 | 说明 |
|---|---|---|
| `🤖 AI 出口` | fallback，**仅 1 个成员** | 只放 `🇺🇸 美国静态IP`，链路断则 AI 直接失败（fail-closed，绝不回落机场共享 IP） |
| `🇺🇸 美国静态IP` | socks5 | 出口固定美国 IP；`dialer-proxy = ⛓️ 链式前置`（走机场中转） |
| `⛓️ 链式前置` | url-test | 健康检查 = **节点→静态代理端口返回 407**（只有真正能承载链式的节点才入选） |
| `<机场>` | select | 外网总入口，默认选 `自动选择` |
| `自动选择` | url-test | **自动排除香港/台湾节点**及订阅信息节点，取最快 |
| `故障转移` | fallback | 同上过滤 |

### 4. 规则优先级（自上而下）

```
1.  AND,((NETWORK,UDP),(DST-PORT,19302)),REJECT    # WebRTC：Google STUN
2.  AND,((NETWORK,UDP),(DST-PORT,3478)),REJECT     # WebRTC：标准 STUN/TURN
3.  AND,((NETWORK,UDP),(DST-PORT,5349)),REJECT     # WebRTC：STUN/TURN over TLS
4.  AND,((NETWORK,UDP),(DST-PORT,443)),REJECT      # 全局禁 QUIC，防绕过域名规则
5.  anthropic.com / claude.ai / claudeusercontent.com /
    openai.com / chatgpt.com / oaistatic.com        → 🤖 AI 出口
6.  accounts.google.com / myaccount.google.com / oauth2.googleapis.com /
    account.google.com / aistudio.google.com / accounts.youtube.com → 🤖 AI 出口
7.  订阅自带规则（YouTube/Google 等 → 机场组；广告 → REJECT）
8.  GEOIP,CN → DIRECT
9.  MATCH → 机场组                                   # 兜底
```

### 4.1 WebRTC / STUN 防泄漏

Chromium 系客户端（**Claude Desktop、浏览器**）会通过 WebRTC 向 STUN 服务器发 UDP 探测，拿到自己的公网出口地址。问题在于：

- 国内 STUN 服务器（如 `stun.chat.bilibili.com:3478`）会被 `GEOIP,CN → DIRECT` 判定为直连；
- 这些 UDP 包**从真实网卡直接发出**，STUN 服务器因此看到真实公网 IP；
- 结果：HTTP 走代理（出口 IP 正确），WebRTC 却把真实 IP 暴露出去。

**修复**：在规则最顶部直接 `REJECT` 三个 STUN 端口。实测（https://ip.cx/webrtc）：

| | HTTP 可见地址 | WebRTC 公网地址 |
|---|---|---|
| 修复前 | 代理出口 IP ✓ | **真实公网 IP** ✗ |
| 修复后 | 代理出口 IP ✓ | 未探测到 ✓ |

**代价**：3478/5349 也用于视频通话 P2P 打洞，可能让 Meet/Teams/飞书降级走 TURN 中继。如遇异常，按 5349 → 3478 的顺序移除，**19302 建议保留**。

### 5. fail-closed：四层防护（防止 AI 流量走错出口）

只靠"代理设置"是**路由**，不是**强制**——代理挂掉/重启的窗口期，流量会静默回落到直连。
所以按"越往下越硬"堆了四层：

| 层 | 机制 | 生效前提 | 实现 |
|---|---|---|---|
| **L1 规则** | AI 域名 → `🤖 AI 出口`（单成员静态 IP）；`MATCH` 不为 DIRECT；REJECT UDP 443 / STUN | mihomo 运行中 | `clash/rules.yaml` + `script.js` |
| **L2 程序代理** | Claude Code 的 `settings.json` `env`、`.zshrc` 的 `HTTP(S)_PROXY` | 程序读取代理变量 | `claude/`、`shell/` |
| **L3 内核封锁** | 直接丢弃到 Anthropic 官方 IP 段（`160.79.104.0/21`、`2607:6bc0::/48`）的出站连接 | 无（系统级，代理挂了也生效） | macOS：`pf` 锚点 / Windows：防火墙出站 Block |
| **L4 进程守护** | 本地代理端口消失 >0.5s → 强杀 Claude 进程并通知 | 无 | macOS：`claude-guard.sh` + LaunchDaemon |

> **L3 才是真正的保证**：代理的出口在远端节点上，本地不会直连 Anthropic，所以封锁这段 IP 不影响正常使用；只有"绕过代理的直连"会被丢包——包括 Clash 重启的那几十秒。

**macOS 实现**（已在使用）：[ggllzz04/macos-claude-failclosed](https://github.com/ggllzz04/macos-claude-failclosed)
—— `pf` 锚点 + `com.claude.guard` / `com.claude.pflock` 两个 LaunchDaemon。日志在 `/var/log/claude-guard.log`，代理消失时会看到：

```
2026-10-25 14:27:11 proxy gone -> kill Claude PIDs: 4592 93297 ...
2026-10-25 14:27:18 proxy back up
```

**Windows 实现**：见 [`windows/anthropic-failclosed.ps1`](./windows/anthropic-failclosed.ps1)（防火墙出站 Block，等价于 pf；回滚脚本在同一目录）。
注意：Windows 上 Claude Desktop（Electron）默认走系统代理，需把系统代理指向 `127.0.0.1:7897`，否则会被 L3 按设计拦住。

### 6. 后台服务（自愈）

| 服务 | 触发 | 作用 |
|---|---|---|
| `com.example.netguard`（LaunchAgent） | 每 30s | 探测外网（国内 DoH 锚点 TCP 443），**连续 3 次失败自动重启 Clash**（治"换网后 Clash 抽风"） |

### 7. 常用命令

```bash
tail -f ~/Library/Logs/netguard.log       # 网络自愈日志
pgrep -fl verge-mihomo                    # Clash 内核
```

---

## 三、目录结构

```
clash/     Clash Verge 覆写：script.js / rules.yaml / merge.yaml / 模板 / profiles 示例
launchd/   netguard 网络自愈（plist + 脚本）
windows/   Windows 版 fail-closed（防火墙 Block + 回滚脚本）
shell/     环境变量代理片段（zsh）
claude/    Claude Code 的 settings.json env 示例
docs/      ARCHITECTURE.md（架构细节）/ TROUBLESHOOTING.md（故障排查手册）
```

## 四、复现步骤（概要）

1. 安装 Clash Verge Rev，开启 TUN 模式（gvisor）。
2. 添加订阅 profile；把 `clash/` 下的 `script.js`、`rules.yaml`、`merge.yaml` 挂到 profile 的 option（script / rules / merge）。
3. 把 `clash/script.js` 里的 `STATIC_NODE` 换成你自己的静态代理（IP / 端口 / 账号 / 密码），或删掉该节点与相关规则。
4. 按需安装 `launchd/com.example.netguard.plist`（路径改成你的用户名）。
5. `claude/settings.example.json` → `~/.claude/settings.json`（只保留你需要的内容）。

## 五、安全说明

- 本仓库**不含**任何订阅 URL、机场节点、静态代理账号密码等敏感信息。
- 提交前已用关键字扫描（机场域名、token、账号、IP 片段）确认无残留。
- 建议保持仓库为 **private**。

## 六、License

[MIT](./LICENSE) © 2026 WORMMMMMM

