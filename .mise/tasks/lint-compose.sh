#!/usr/bin/env bash
set -euo pipefail
#MISE description="Validate compose files render with podman-compose (config must succeed)"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="Compose YAML files (default: every *compose*.y*ml tracked by git)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-compose" "$@"
trap 'metrics_end $?' EXIT
source "$ROOT/scripts/lint-lib.sh"

MODE=all
[ "${usage_changed:-}" = "true" ] && MODE=--changed

FILES=()
if [ -n "${usage_files:-}" ]; then
  read -r -a FILES <<<"$usage_files"
else
  mapfile -t FILES < <(lint_list_files compose "$MODE")
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no compose files"
  exit 0
fi

for f in "${FILES[@]}"; do
  echo "validating $f:"
  # podman-compose resolves -f relative to its own cwd → always pass absolute
  podman-compose --in-pod 1 -f "$ROOT/$f" config >/dev/null
done
echo "compose lint OK (${#FILES[@]} file(s))"
