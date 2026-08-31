#!/usr/bin/env bash
set -euo pipefail
#MISE description="Lint/format JS, TS and JSON with Biome (recommended rules + assist, error-on-warnings)"
#USAGE flag "--fix" help="Apply safe fixes and formatting"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="Files or directories (default: whole repo)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-js" "$@"
trap 'metrics_end $?' EXIT
source "$ROOT/scripts/lint-lib.sh"

FIX=()
if [ "${usage_fix:-}" = "true" ]; then FIX=(--write); fi

TARGETS=()
if [ -n "${usage_files:-}" ]; then
  read -r -a TARGETS <<<"$usage_files"
elif [ "${usage_changed:-}" = "true" ]; then
  mapfile -t TARGETS < <(lint_list_files js --changed)
else
  TARGETS=(".")
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "no JS/TS/JSON files"
  exit 0
fi

biome check --error-on-warnings "${FIX[@]}" "${TARGETS[@]}"
