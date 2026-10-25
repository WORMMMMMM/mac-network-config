# Windows 版 Claude fail-closed（等价于 macOS 的 pf 内核封锁）
#
# 作用：在内核/防火墙层阻断"直连 Anthropic 官方 IP 段"的所有出站流量。
# 代理的出口在远端节点上（机场节点 / 静态 IP），本地不直连 Anthropic，
# 因此这条规则不会影响"经代理"的正常流量；只有绕过代理的直连会被丢包。
#
# 需要管理员权限运行（右键 PowerShell → 以管理员身份运行，或计划任务 /RL HIGHEST）。
#
# 为什么要它：只靠环境变量/系统代理是"路由"而不是"强制"。Clash 重启、
# 崩溃或被关掉的窗口期，走 TUN 的程序会回落直连，真实 IP 就暴露给 Anthropic。
# 这条 Block 规则是那段时间里唯一还生效的东西。
#
# 回滚：windows/anthropic-failclosed-rollback.ps1

$ErrorActionPreference = "Stop"

$ranges = [ordered]@{
    "IPv4" = "160.79.104.0/21"      # Anthropic 公布出站段（含入站 /23 的超集）
    "IPv6" = "2607:6bc0::/48"       # Anthropic IPv6
}

foreach ($family in $ranges.Keys) {
    $name = "Claude fail-closed: block direct Anthropic $family"
    Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $name `
        -Direction Outbound -Action Block `
        -RemoteAddress $ranges[$family] -Profile Any `
        -Description "Fail-closed: Anthropic traffic must go through the local proxy; direct connections are dropped." | Out-Null
    Write-Host "已添加规则: $name -> $($ranges[$family])"
}

Write-Host ""
Write-Host "当前规则状态:"
Get-NetFirewallRule -DisplayName "Claude fail-closed*" |
    Select-Object DisplayName, Enabled, Direction, Action |
    Format-Table -AutoSize

Write-Host ""
Write-Host "注意：Claude Desktop（Electron）默认走系统代理。请把系统代理指向 127.0.0.1:7897，"
Write-Host "      否则它会被这条规则按设计拦住（宁可失败，也不直连）。"
