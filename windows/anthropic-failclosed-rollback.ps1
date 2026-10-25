# 回滚：删除 Windows 上的 Anthropic 直连阻断规则
# 用法（管理员 PowerShell）：powershell -ExecutionPolicy Bypass -File .\anthropic-failclosed-rollback.ps1
Remove-NetFirewallRule -DisplayName "Claude fail-closed*" -ErrorAction SilentlyContinue
Write-Host "已删除 'Claude fail-closed' 相关防火墙规则。"
Get-NetFirewallRule -DisplayName "Claude fail-closed*" -ErrorAction SilentlyContinue |
    Select-Object DisplayName, Enabled
