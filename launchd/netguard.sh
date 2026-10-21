#!/opt/homebrew/bin/bash
# 上网体检员（netguard）：本机网络在、但外网不通（换网后 Clash 未重新接管 DNS/路由的经典抽风）
# → 抓现场快照 → 自动重启 Clash Verge。由 LaunchAgent（com.ziming.netguard）每 30 秒唤起。
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

BASE="$HOME/.netguard"
STATE="$BASE/fails"
LOG="$HOME/Library/Logs/netguard.log"
mkdir -p "$BASE"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 没有默认路由（WiFi 根本没连上）→ 不是 Clash 的问题，什么都不做
gw="$(route -n get default 2>/dev/null | awk '/gateway:/{print $2; exit}')"
[ -z "$gw" ] && exit 0

# 外网健康：两个国内 DOH 锚点（TCP 443，都失败才算不通）
ok=1
nc -z -G 3 223.5.5.5 443   >/dev/null 2>&1 && ok=1 || \
nc -z -G 3 119.29.29.29 443 >/dev/null 2>&1 && ok=1 || ok=0

fails=$(cat "$STATE" 2>/dev/null || echo 0)

if [ "$ok" = "1" ]; then
  [ "$fails" != "0" ] && { echo 0 > "$STATE"; log "外网恢复 ✓（清空计数）"; }
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$STATE"
log "外网体检失败（第 ${fails}/3 次；网关=${gw}）"
[ "$fails" -lt 3 ] && exit 0

# —— 连续三连败：抓现场快照，然后重启 Clash ——
{
  echo "──── 现场快照 $(date '+%F %T') ────"
  echo "[默认路由]"; route -n get default 2>&1 | grep -E 'gateway|interface'
  echo "[系统 DNS]"; scutil --dns 2>/dev/null | grep nameserver | head -4
  echo "[内核进程]"; pgrep -fl 'verge-mihomo' | head -2
  echo "[Clash 日志尾]"; tail -n 8 "$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/logs/"*.log 2>/dev/null | tail -8
} >> "$LOG"

log "连续失败 → 自动重启 Clash Verge…"
osascript -e 'quit app "Clash Verge"' >/dev/null 2>&1
sleep 4
if pgrep -x "Clash Verge" >/dev/null 2>&1; then
  log "（Apple 事件没关掉它，改用 TERM）"
  pkill -TERM -x "Clash Verge" >/dev/null 2>&1
  sleep 3
fi
pgrep -x "Clash Verge" >/dev/null 2>&1 && { pkill -KILL -x "Clash Verge" >/dev/null 2>&1; sleep 2; }
open -a "Clash Verge"
sleep 15

if nc -z -G 3 223.5.5.5 443 >/dev/null 2>&1 || nc -z -G 3 119.29.29.29 443 >/dev/null 2>&1; then
  log "重启后外网恢复 ✓"
  echo 0 > "$STATE"
else
  log "重启后仍不通（保留计数，90 秒后再试一轮；仍不行需人工）"
  echo 2 > "$STATE"
fi
