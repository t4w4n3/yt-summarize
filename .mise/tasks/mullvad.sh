#!/usr/bin/env bash
set -euo pipefail
#MISE description="Mullvad: rotation de relais (scan), provisioning de la config (init) et debug du tunnel (run/test/dryrun)"
#USAGE arg "[mode]" help="run | test | init | scan | dryrun | status" default="status"
#USAGE arg "[cmd...]" help="Commande à exécuter DANS le container VPN (après --)"
#USAGE flag "-r --relay <hostname>" help="Relais Mullvad (défaut fr-mrs-wg-001; fr-par-wg-001 est blacklisté par YouTube)" env="MULLVAD_RELAY"
#USAGE flag "-w --wg-port <port>" help="Port WireGuard (défaut 51820)" env="MULLVAD_WG_PORT"
#USAGE flag "-a --account <number>" help="Numéro de compte Mullvad (16 chiffres)" env="MULLVAD_ACCOUNT"
#USAGE flag "-i --ip <address>" help="Adresse de tunnel Mullvad déjà attribuée (ex: 10.64.0.100/32) — saute l'API" env="MULLVAD_ADDR"

ROOT="${MISE_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

MODE="${usage_mode:-${1:-status}}"
RELAY="${usage_relay:-fr-mrs-wg-001}"
WG_PORT="${usage_wg_port:-51820}"
ACCOUNT="${usage_account:-${MULLVAD_ACCOUNT:-}}"
IP_ADDR="${usage_ip:-${MULLVAD_ADDR:-}}"
STATE_DIR="$HOME/.local/mullvad-poc"
CONF="$STATE_DIR/wg0.conf"
VPN_DNS="10.64.0.1"
OUT_DIR="$STATE_DIR/out"

# Drop the mode word, then an optional '--' separator; the rest is the command.
[ $# -ge 1 ] && shift
[ "${1:-}" = "--" ] && shift

pick_image() {
  # L'image projet (avec yt-dlp + ffmpeg + wireguard-tools) doit être construite.
  for c in summarize-yt_app summarize-yt_worker; do
    if podman image exists "localhost/$c:latest" 2>/dev/null; then
      echo "localhost/$c:latest"
      return 0
    fi
  done
  echo "Image projet absente — lance d'abord: mise run build" >&2
  exit 1
}

# shellcheck source=../scripts/mullvad-lib.sh
. "$ROOT/scripts/mullvad-lib.sh"

need_account() {
  if [ -z "$ACCOUNT" ]; then
    echo "Il me faut la clé Mullvad (16 chiffres): MULLVAD_ACCOUNT=<numero> ou -a <numero>" >&2
    exit 1
  fi
  if ! printf '%s' "$ACCOUNT" | grep -qE '^[0-9]{16}$'; then
    echo "MULLVAD_ACCOUNT doit être un nombre à 16 chiffres (reçu: '$ACCOUNT')." >&2
    exit 1
  fi
}

podman_vpn_run() {
  # Lance <cmd...> dans un container jetable dont TOUT le trafic sort par le
  # tunnel WireGuard Mullvad. L'hôte n'est jamais touché (routes, firewall, DNS).
  # Prerequis: /dev/net/tun + CAP_NET_ADMIN (container rootless OK).
  [ -f "$CONF" ] || {
    echo "Pas de config WireGuard ($CONF). Étape requise: mise run mullvad init" >&2
    exit 1
  }
  mkdir -p "$OUT_DIR"
  podman run --rm \
    --cap-add NET_ADMIN \
    --device /dev/net/tun \
    --dns "$VPN_DNS" \
    -v "$CONF:/cfg/wg0.conf:ro" \
    -v "$OUT_DIR:/out" \
    "$(pick_image)" \
    sh -c 'wg-quick up /cfg/wg0.conf >&2 && exec "$@"' _ "$@"
}

cmd_init() {
  # Écrit wg0.conf. Trois voies (mêmes fonctions que `mise run setup`):
  #  - MULLVAD_ACCOUNT: enregistre la pubkey via l'API Mullvad (adresse auto);
  #  - -i/--ip <addr>: adresse déjà attribuée (page Mullvad), on saute l'API;
  #  - rien: interactif — génère la paire, affiche la pubkey à enregistrer
  #    sur mullvad.net, puis demande l'adresse attribuée.
  # La clé privée n'est JAMAIS affichée: elle est lue uniquement pour écrire le fichier.
  if [ -n "$ACCOUNT" ]; then
    need_account
    mullvad_keygen
    echo "Enregistrement de la clé publique auprès de Mullvad (relais $RELAY)..."
    RESP="$(curl --fail --silent --show-error \
      -d "account=$ACCOUNT" \
      -d "pubkey=$(cat "$STATE_DIR/pubkey")" \
      https://api.mullvad.net/wg)" || {
      echo "L'enregistrement a échoué (compte invalide ? réseau ?)." >&2
      exit 1
    }
    echo "$RESP" > "$STATE_DIR/register.json"
    ADDR="$(python3 - "$STATE_DIR/register.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f'JSON invalide: {e}')
addrs = data.get('addresses') or []
print(', '.join(addrs))
PY
)"
    if [ -z "$ADDR" ]; then
      echo "Réponse API inattendue (pas d'addresses):" >&2
      cat "$STATE_DIR/register.json" >&2
      exit 1
    fi
    mullvad_build_conf "$ADDR" "$RELAY"
  elif [ -n "$IP_ADDR" ]; then
    mullvad_keygen
    mullvad_build_conf "$IP_ADDR" "$RELAY"
  else
    mullvad_provision_interactive "$RELAY"
  fi
}

cmd_dryrun() {
  # Valide la plomberie container (tun + NET_ADMIN + wg-quick + routage du
  # tunnel) avec une config factice (clés distinctes, endpoint = vrai relais).
  # Preuve: curl doit TIMEOUT (trafic dans wg0, pas de peer valide).
  TMP_CONF="/tmp/mullvadok.conf"
  rm -f "$TMP_CONF" /tmp/.mullvad-poc-ka /tmp/.mullvad-poc-kb /tmp/.mullvad-poc-kb.pub
  umask 077
  mullvad_refresh_relays
  node "$ROOT/scripts/wgkey.js" > /tmp/.mullvad-poc-ka
  node "$ROOT/scripts/wgkey.js" > /tmp/.mullvad-poc-kb
  sed -n '2p' /tmp/.mullvad-poc-kb > /tmp/.mullvad-poc-kb.pub
  RELAY_IP="$(python3 - "$RELAY" <<'PY'
import json, sys
relay = sys.argv[1]
data = json.load(open('/tmp/mullvad-relays.json'))
for r in data:
    if r.get('type') == 'wireguard' and r.get('active') and r.get('hostname') == relay:
        print(r.get('ipv4_addr_in') or '')
        break
PY
)"
  [ -n "$RELAY_IP" ] || { echo "Relais $RELAY introuvable dans /tmp/mullvad-relays.json" >&2; exit 1; }
  cat > "$TMP_CONF" <<EOF
[Interface]
PrivateKey = $(sed -n '1p' /tmp/.mullvad-poc-ka)
Address = 10.99.0.2/32
Table = off
PostUp = GW=\$(ip route show default | awk '{print \$3; exit}'); IF=\$(ip route show default | awk '{print \$5; exit}'); ip route add $RELAY_IP via \$GW dev \$IF; ip route add default dev wg0; ip -6 route add ::/0 dev wg0 2>/dev/null || true
PreDown = ip route del default dev wg0 2>/dev/null || true; ip -6 route del ::/0 dev wg0 2>/dev/null || true

[Peer]
PublicKey = $(cat /tmp/.mullvad-poc-kb.pub)
Endpoint = $RELAY_IP:$WG_PORT
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
  echo ">> Container test: wg-quick up + vérification du routage (sans compte Mullvad)"
  podman run --rm \
    --cap-add NET_ADMIN \
    --device /dev/net/tun \
    --dns "$VPN_DNS" \
    -v "$TMP_CONF:/cfg/wg0.conf:ro" \
    "$(pick_image)" \
    sh -c '
      set -e
      wg-quick up /cfg/wg0.conf
      echo "--- peer (doit être présent) ---"; wg show wg0 | grep -E "peer:|allowed"
      echo "--- routes (default dev wg0 attendue) ---"; ip route | grep -E "wg0|default"
      echo "--- test routage: curl DOIT timeout (trafic dans wg0, clés factices) ---"
      CODE=$(curl -s --max-time 4 -o /dev/null -w "%{http_code}" http://1.1.1.1 || true)
      if [ "$CODE" = "000" ]; then
        echo "OK: trafic routé dans wg0 (code=$CODE)"
      else
        echo "ECHEC: trafic sorti hors tunnel (code=$CODE)"; exit 1
      fi
      wg-quick down wg0 >/dev/null 2>&1 || true
    '
  rm -f "$TMP_CONF" /tmp/.mullvad-poc-ka /tmp/.mullvad-poc-kb /tmp/.mullvad-poc-kb.pub
  echo
  echo "dryrun OK — plomberie container WireGuard fonctionnelle."
  echo "Prochaine étape: mise run mullvad init (ou déjà fait par 'mise run setup')"
}

cmd_test() {
  # Test en conditions réelles (nécessite le compte Mullvad + init fait).
  # Affiche l'IP de sortie via le tunnel puis simule un download yt-dlp.
  podman_vpn_run sh -c '
    echo "IP de sortie via Mullvad: $(curl -s --max-time 15 https://api.ipify.org)"
    exec "$@"
  ' _ yt-dlp --force-ipv4 --simulate --no-warnings --print "%(title)s" "${1:-https://www.youtube.com/watch?v=dQw4w9WgXcQ}"
}

cmd_run() {
  [ $# -ge 1 ] || {
    echo "Usage: mise run mullvad run -- <commande...>" >&2
    echo "Exemple: mise run mullvad run -- yt-dlp --simulate https://youtu.be/dQw4w9WgXcQ" >&2
    exit 1
  }
  echo ">> Dans le container VPN Mullvad: $*"
  podman_vpn_run "$@"
}

cmd_scan() {
  # Teste une liste de relais (même clé/adresse) pour trouver une IP de sortie
  # non blacklistée par YouTube. Le blacklistage évolue: relance régulièrement.
  mullvad_refresh_relays
  [ -f "$STATE_DIR/privkey" ] || { echo "Pas de clé privée ($STATE_DIR/privkey)." >&2; exit 1; }
  local relays=(
    fr-mrs-wg-001 fr-bod-wg-001 se-got-wg-001 no-osl-wg-001 fi-hel-wg-001
    ch-zrh-wg-201 gb-mnc-wg-201 us-atl-wg-001 us-dal-wg-001 us-bos-wg-001
    al-tia-wg-001 ca-van-wg-201 de-fra-wg-001 nl-ams-wg-001
  )
  echo "Relais | IP sortie | YouTube | Verdict"
  echo "--------------------------------------"
  for R in "${relays[@]}"; do
    local RIP RPUB
    RIP="$(mullvad_relay_field "$R" ipv4)"
    RPUB="$(mullvad_relay_field "$R" pubkey)"
    [ -n "$RIP" ] && [ -n "$RPUB" ] || { echo "$R | (introuvable dans la liste)"; continue; }
    local TMP="/tmp/mullvad-scan-$R.conf"
    umask 077
    cat > "$TMP" <<EOF
[Interface]
PrivateKey = $(cat "$STATE_DIR/privkey")
Address = $(sed -n 's/^Address = //p' "$CONF" 2>/dev/null || echo '10.0.0.1/32')
MTU = 1420
Table = off
PostUp = GW=\$(ip route show default | awk '{print \$3; exit}'); IF=\$(ip route show default | awk '{print \$5; exit}'); ip route add $RIP via \$GW dev \$IF; ip route add default dev wg0

[Peer]
PublicKey = $RPUB
Endpoint = $RIP:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
    local RESULT CODE EXIT
    RESULT="$(timeout 60 podman run --rm --cap-add NET_ADMIN --device /dev/net/tun --dns "$VPN_DNS" \
      -v "$TMP:/cfg/wg0.conf:ro" "$(pick_image)" \
      sh -c 'wg-quick up /cfg/wg0.conf >/dev/null 2>&1 || exit 2
        EXIT=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null)
        CODE=$(curl -s --connect-timeout 3 --max-time 6 -o /dev/null -w "%{http_code}" https://www.youtube.com 2>/dev/null)
        echo "$EXIT|$CODE"
        wg-quick down wg0 >/dev/null 2>&1 || true' 2>/dev/null || true)"
    CODE="${RESULT##*|}"
    EXIT="${RESULT%|*}"
    case "$CODE" in
      200|301|302|303) echo "$R | $EXIT | $CODE | ✅ PASS" ;;
      *) echo "$R | $EXIT | $CODE | ❌ blacklisté" ;;
    esac
    rm -f "$TMP"
  done
  echo
  echo "Relais OK -> mise run mullvad init -i <adresse> -r <relais>"
}

cmd_status() {
  echo "=== Environnement Mullvad ==="
  echo "MULLVAD_ACCOUNT: $([ -n "$ACCOUNT" ] && echo défini || echo "NON défini (MULLVAD_ACCOUNT=<16 chiffres>)")"
  echo "Config WireGuard: $([ -f "$CONF" ] && echo "présente ($CONF)" || echo "absente — 'mise run mullvad init'")"
  echo "Image projet: $(podman image exists localhost/summarize-yt_app:latest 2>/dev/null && echo "construite" || echo "ABSENTE — 'mise run build'")"
  echo "Relais par défaut: $RELAY:$WG_PORT"
  echo
  echo "=== IP sortante actuelle (hôte, hors VPN) ==="
  curl -s --max-time 10 https://api.ipify.org && echo
  echo
  echo "=== Modes ==="
  echo "  init    paire + wg0.conf (compte API, -i, ou interactif — idem 'mise run setup')"
  echo "  test    IP de sortie + download yt-dlp simulé via le tunnel"
  echo "  run -- <cmd...>   exécute <cmd> dans le container VPN"
  echo "  dryrun  valide la plomberie container sans compte"
}

case "$MODE" in
  run)    cmd_run "$@" ;;
  test)   cmd_test "$@" ;;
  init)   cmd_init ;;
  scan)   cmd_scan ;;
  dryrun) cmd_dryrun ;;
  status) cmd_status ;;
  *) echo "Mode inconnu: $MODE (run|test|init|scan|dryrun|status)" >&2; exit 1 ;;
esac
