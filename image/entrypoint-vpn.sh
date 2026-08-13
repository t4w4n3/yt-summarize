#!/usr/bin/env bash
set -euo pipefail
# Sidecar VPN (compose): monte le tunnel WireGuard Mullvad dans SON netns, puis
# expose un proxy SOCKS5 local. Seul le trafic qui passe par ce proxy (yt-dlp
# du worker, via --proxy socks5h://127.0.0.1:1080) sort par Mullvad. L'hôte et
# les autres containers ne sont jamais touchés.

wg-quick up /cfg/wg0.conf
exec node /app/src/vpn/socks5.js
