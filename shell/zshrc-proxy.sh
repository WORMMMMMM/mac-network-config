# 环境变量代理（追加到 ~/.zshrc）
# 作用：命令行工具（git / curl / claude / codex 等）统一走 Clash 的混合端口。
# NO_PROXY 白名单保证私有网段与回环直连。

export NO_PROXY="127.0.0.1,localhost,::1,192.168.0.0/16"
export no_proxy="$NO_PROXY"
export HTTP_PROXY="http://127.0.0.1:7897"
export HTTPS_PROXY="http://127.0.0.1:7897"
export ALL_PROXY="socks5://127.0.0.1:7897"
