#!/usr/bin/env bash
set -euo pipefail
#MISE description="Stop the stack (keeps the jobs DB and artifacts volumes)"
#MISE alias="stop"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "down" "$@"
trap 'metrics_end $?' EXIT

# podman-compose 1.3.0 est bruyant sur les runs idempotents : il tente
# `podman rm -f` / `pod rm -f` même quand rien n'existe, ce qui sort des
# "Error: no such container/pod" rouges alors que l'opération est légitime.
# Le worker en host-network peut aussi déclencher une race netavark setns
# transitoire ("Invalid argument") au teardown rootless, nettoyée au retry.
# On filtre ces bruits bénins pour la tolérance zéro bruit, mais on laisse
# passer toute autre erreur réelle.
# INTENTIONAL: filtrage bruit bénin podman-compose/netavark - réévaluer en bumpant podman-compose >1.3.0 / podman >5.4 / netavark >1.14
_tmp="$(mktemp)"
set +e
podman-compose down >"$_tmp" 2>&1
_status=$?
set -e
# Affiche tout sauf les patterns bénins
# shellcheck disable=SC2143
if grep -qvE 'Error: no (container|pod) with (name or ID|ID or name).*found: no such (container|pod)|Error: removing container .* netavark: setns: IO error: Invalid argument' "$_tmp"; then
  grep -vE 'Error: no (container|pod) with (name or ID|ID or name).*found: no such (container|pod)|Error: removing container .* netavark: setns: IO error: Invalid argument' "$_tmp" || true
else
  # que du bruit bénin -> n'affiche rien (down idempotent propre)
  :
fi
# Si podman-compose a échoué pour une vraie raison (autre Error:), propage
if [ "$_status" -ne 0 ]; then
  if grep -vE 'Error: no (container|pod) with|netavark: setns' "$_tmp" | grep -qE '^Error:'; then
    rm -f "$_tmp"
    exit "$_status"
  fi
  # sinon échec uniquement dû au bruit filtré -> considère comme succès idempotent
fi
rm -f "$_tmp"
