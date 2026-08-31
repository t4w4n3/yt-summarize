#!/usr/bin/env bash
set -euo pipefail
#MISE description="yamllint in strict mode (warnings fail) on all YAML files"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="YAML files (default: every *.yml/*.yaml tracked by git)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-yaml" "$@"
trap 'metrics_end $?' EXIT
source "$ROOT/scripts/lint-lib.sh"

MODE=all
[ "${usage_changed:-}" = "true" ] && MODE=--changed

FILES=()
if [ -n "${usage_files:-}" ]; then
  read -r -a FILES <<<"$usage_files"
else
  mapfile -t FILES < <(lint_list_files yaml "$MODE")
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no YAML files"
  exit 0
fi

yamllint -s "${FILES[@]}"
echo "yaml lint OK (${#FILES[@]} file(s))"
