#!/usr/bin/env bash
set -euo pipefail
#MISE description="markdownlint on all Markdown files (config: .markdownlint.yaml)"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="Markdown files (default: every *.md tracked by git)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-md" "$@"
trap 'metrics_end $?' EXIT
source "$ROOT/scripts/lint-lib.sh"

MODE=all
[ "${usage_changed:-}" = "true" ] && MODE=--changed

FILES=()
if [ -n "${usage_files:-}" ]; then
  read -r -a FILES <<<"$usage_files"
else
  mapfile -t FILES < <(lint_list_files md "$MODE")
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no Markdown files"
  exit 0
fi

pnpm exec markdownlint --config .markdownlint.yaml "${FILES[@]}"
echo "markdown lint OK (${#FILES[@]} file(s))"
