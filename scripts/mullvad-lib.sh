# shellcheck shell=bash
# Fonctions partagées Mullvad (source depuis setup.sh et mullvad.sh).
# Provisioning d'une paire WireGuard + écriture de wg0.conf. La clé privée est
# générée localement (Node, X25519) et n'est jamais affichée ni versionnée.

MULLVAD_DIR="${MULLVAD_DIR:-${STATE_DIR:-$HOME/.local/mullvad-poc}}"
MULLVAD_CONF="${MULLVAD_CONF:-$MULLVAD_DIR/wg0.conf}"
MULLVAD_DNS="${MULLVAD_DNS:-10.64.0.1}"
MULLVAD_RELAY_DEFAULT="${MULLVAD_RELAY_DEFAULT:-fr-mrs-wg-001}"
MULLVAD_WG_PORT="${MULLVAD_WG_PORT:-51820}"
MULLVAD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mullvad_keygen() {
  # Génère la paire (privkey + pubkey) si absente; dérive la pubkey sinon.
  local old_umask
  old_umask="$(umask)"
  umask 077
  mkdir -p "$MULLVAD_DIR"
  if [ ! -f "$MULLVAD_DIR/privkey" ]; then
    node "$MULLVAD_LIB_DIR/wgkey.ts" >"$MULLVAD_DIR/.keys.new"
    sed -n '1p' "$MULLVAD_DIR/.keys.new" >"$MULLVAD_DIR/privkey"
    sed -n '2p' "$MULLVAD_DIR/.keys.new" >"$MULLVAD_DIR/pubkey"
    rm -f "$MULLVAD_DIR/.keys.new"
    echo "Paire de clés WireGuard générée dans $MULLVAD_DIR/ (0600)."
  elif [ ! -f "$MULLVAD_DIR/pubkey" ]; then
    node "$MULLVAD_LIB_DIR/wgkey.ts" pubkey <"$MULLVAD_DIR/privkey" >"$MULLVAD_DIR/pubkey"
  fi
  chmod 600 "$MULLVAD_DIR/privkey" "$MULLVAD_DIR/pubkey"
  umask "$old_umask"
}

mullvad_print_instructions() {
  echo
  echo "============================================================"
  echo " Mullvad — configuration WireGuard"
  echo "============================================================"
  echo " 1. Ouvre https://mullvad.net/account (section WireGuard) et"
  echo "    enregistre cette clé PUBLIQUE:"
  echo
  echo "    $(cat "$MULLVAD_DIR/pubkey")"
  echo
  echo " 2. Mullvad t'attribue une adresse de tunnel (10.x.x.x/32)."
  echo "    (Clé privée: $MULLVAD_DIR/privkey — ne la partage jamais.)"
  echo "============================================================"
  echo
}

mullvad_refresh_relays() {
  [ -s /tmp/mullvad-relays.json ] || curl -s --max-time 30 https://api.mullvad.net/www/relays/all/ -o /tmp/mullvad-relays.json
}

mullvad_relay_field() { # $1=hostname $2=ipv4|pubkey
  python3 - "$1" "$2" <<'PY'
import json, sys
relay, field = sys.argv[1], sys.argv[2]
try:
    data = json.load(open('/tmp/mullvad-relays.json'))
except Exception:
    sys.exit(1)
for r in data:
    if r.get('type') == 'wireguard' and r.get('active') and r.get('hostname') == relay:
        print(r.get('ipv4_addr_in') if field == 'ipv4' else r.get('pubkey') or '')
        break
PY
}

mullvad_build_conf() { # $1 = adresse de tunnel (10.x.x.x/32), $2 = relais
  local addr="$1" relay="${2:-$MULLVAD_RELAY_DEFAULT}" rip rpub
  mullvad_refresh_relays
  rip="$(mullvad_relay_field "$relay" ipv4)"
  rpub="$(mullvad_relay_field "$relay" pubkey)"
  if [ -z "$rip" ] || [ -z "$rpub" ]; then
    echo "Relais $relay introuvable — rafraîchis la liste: curl -s https://api.mullvad.net/www/relays/all/ -o /tmp/mullvad-relays.json" >&2
    return 1
  fi
  umask 077
  cat >"$MULLVAD_CONF" <<EOF
[Interface]
PrivateKey = $(cat "$MULLVAD_DIR/privkey")
Address = $addr
# MTU 1420: wg-quick hériterait du MTU de pasta (65520) et les gros paquets
# seraient perdus (fragmentation). 1420 = 1500 - 80 d'overhead WireGuard.
MTU = 1420
# Pas de ligne DNS: le wg-quick Debian (patché) exige resolvconf, absent de
# l'image. Le proxy SOCKS5 résout via le DNS Mullvad (10.64.0.1).
# Table=off: on gère nous-mêmes le routage (le schéma fwmark de wg-quick a
# besoin de sysctl src_valid_mark, refusé en rootless podman). PostUp pose la
# route de l'endpoint via la gateway pasta, puis la default via wg0.
Table = off
PostUp = GW=\$(ip route show default | awk '{print \$3; exit}'); IF=\$(ip route show default | awk '{print \$5; exit}'); ip route add $rip via \$GW dev \$IF; ip route add default dev wg0; ip -6 route add ::/0 dev wg0 2>/dev/null || true
PreDown = ip route del default dev wg0 2>/dev/null || true; ip -6 route del ::/0 dev wg0 2>/dev/null || true

[Peer]
PublicKey = $rpub
Endpoint = $rip:$MULLVAD_WG_PORT
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
  chmod 600 "$MULLVAD_CONF"
  echo "Config écrite: $MULLVAD_CONF (IP tunnel $addr via $relay $rip:$MULLVAD_WG_PORT)."
}

mullvad_provision_interactive() { # $1 = relais (défaut fr-mrs-wg-001)
  # Génère la paire, affiche la pubkey à enregistrer sur mullvad.net, puis
  # demande l'adresse attribuée. Retourne 0 si config écrite, 1 si ignoré.
  local relay="${1:-$MULLVAD_RELAY_DEFAULT}"
  mullvad_keygen
  if [ -f "$MULLVAD_CONF" ]; then
    echo "Mullvad déjà configuré ($MULLVAD_CONF) — rien à faire."
    return 0
  fi
  mullvad_print_instructions
  if [ ! -t 0 ]; then
    echo "stdin non-interactif: étape Mullvad ignorée (relance 'mise run setup' en interactif," >&2
    echo "ou 'mise run mullvad init -i <adresse>' / MULLVAD_ACCOUNT=<16 chiffres>)." >&2
    return 1
  fi
  read -r -p "Adresse de tunnel attribuée (ex: 10.64.0.100/32) ou Entrée pour ignorer: " addr
  if [ -z "$addr" ]; then
    echo "Ignoré — config Mullvad non créée (le service vpn restera arrêté)."
    return 1
  fi
  mullvad_build_conf "$addr" "$relay"
}
