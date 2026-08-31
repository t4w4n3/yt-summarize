#!/usr/bin/env bash
set -euo pipefail
#MISE description="Stop the stack and DELETE all data (jobs DB + artifacts)"
#USAGE flag "-y --yes" help="Skip the confirmation prompt"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "clean" "$@"
trap 'metrics_end $?' EXIT

if [ "${usage_yes:-false}" != "true" ]; then
  read -r -p "This deletes the jobs database and every artifact. Type 'clean' to confirm: " answer
  if [ "$answer" != "clean" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# Même bruit bénin que down.sh (idempotent + netavark race) — on filtre.
# INTENTIONAL: filtrage bruit bénin podman-compose/netavark - réévaluer en bumpant podman-compose >1.3.0 / netavark >1.14
_tmp="$(mktemp)"
set +e
podman-compose down -v >"$_tmp" 2>&1
_status=$?
set -e
grep -vE 'Error: no (container|pod) with (name or ID|ID or name).*found: no such (container|pod)|Error: removing container .* netavark: setns: IO error: Invalid argument' "$_tmp" || true
if [ "$_status" -ne 0 ]; then
  if grep -vE 'Error: no (container|pod) with|netavark: setns' "$_tmp" | grep -qE '^Error:'; then
    rm -f "$_tmp"
    exit "$_status"
  fi
fi
rm -f "$_tmp"
