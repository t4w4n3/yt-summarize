#!/usr/bin/env bash
set -euo pipefail
#MISE description="One-time setup: create .env, install npm deps, Playwright browser, generate the Mullvad WireGuard keypair"
#MISE alias="install"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (tune PORT / model settings there)."
else
  echo ".env already exists; leaving it untouched."
fi

npm ci
npx playwright install chromium

echo
echo "Mullvad VPN (YouTube downloads) — paire de clés WireGuard:"
# shellcheck source=scripts/mullvad-lib.sh
. "$ROOT/scripts/mullvad-lib.sh"
if ! mullvad_provision_interactive; then
  echo "  (configurable plus tard: 'mise run mullvad init' ou MULLVAD_ENABLED=false)"
fi

echo
echo "Setup complete."
echo "  Next: mise run up      # build and start the stack"
echo "        mise run test    # run the hermetic e2e suite (no stack needed)"
