#!/usr/bin/env bash
set -euo pipefail
# Sidecar VPN (compose): monte le tunnel WireGuard Mullvad dans SON netns, puis
# expose un proxy SOCKS5 local. Seul le trafic qui passe par ce proxy (yt-dlp
# du worker, via --proxy socks5h://127.0.0.1:1080) sort par Mullvad. L'hôte et
# les autres containers ne sont jamais touchés.
#
# Sans config (clone frais): message clair + sleep infinity (reste vivant pour
# que restart: unless-stopped ne boucle pas, cf. compose.yaml). Le stack tourne
# quand même; pour télécharger en direct: MULLVAD_ENABLED=false dans .env.

if [ ! -f /mullvad/wg0.conf ]; then
  echo "Mullvad non configuré — lance 'mise run mullvad init' (README §Mullvad VPN)." >&2
  echo "Le service vpn reste en attente (sleep infinity); pour télécharger en direct: MULLVAD_ENABLED=false dans .env" >&2
  # Reste vivant pour que restart: unless-stopped ne boucle pas (cf. compose.yaml).
  exec sleep infinity
fi

cp /mullvad/wg0.conf /tmp/wg0.conf
chmod 600 /tmp/wg0.conf
wg-quick up /tmp/wg0.conf
exec node /app/src/vpn/socks5.ts
