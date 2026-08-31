#!/usr/bin/env bash
set -euo pipefail
#MISE description="shellcheck (severity=style, all optional checks) + shfmt formatting check on shell scripts"
#USAGE flag "--fix" help="Rewrite scripts with shfmt (shellcheck findings are not auto-fixable)"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="Shell scripts (default: every tracked *.sh)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-shell" "$@"
trap 'metrics_end $?' EXIT
source "$ROOT/scripts/lint-lib.sh"

MODE=all
[ "${usage_changed:-}" = "true" ] && MODE=--changed

FILES=()
if [ -n "${usage_files:-}" ]; then
  read -r -a FILES <<<"$usage_files"
else
  mapfile -t FILES < <(lint_list_files sh "$MODE")
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no shell scripts"
  exit 0
fi

echo "── shellcheck --severity=style --enable=all"
# Max strictness: every standard check at style level + all OPTIONAL checks,
# minus the handful of optional checks that contradict this repo's conventions:
#   SC2250 — braces around $var: project style keeps bare "$var" (shfmt-enforced formatting)
#   SC2292 — prefer [[ ]]: tasks deliberately use POSIX [ ]
#   SC2312/SC2310 — masked return values / || in [ ]: intentional in task control flow
#   SC2154 — usage_* vars are injected by mise's #USAGE layer, invisible to shellcheck
#   SC1091 — not following dynamically-sourced helpers (mise task layout)
shellcheck --severity=style --external-sources \
  --enable=all \
  -e SC2250,SC2292,SC2312,SC2310,SC2154,SC1091 \
  "${FILES[@]}"
echo "shellcheck OK (${#FILES[@]} file(s))"

echo "── shfmt (-i 2 -ci -bn)"
SHFMT_FLAGS=(-i 2 -ci -bn)
if [ "${usage_fix:-}" = "true" ]; then
  shfmt "${SHFMT_FLAGS[@]}" -w "${FILES[@]}"
  echo "shfmt rewrote files in place"
else
  shfmt "${SHFMT_FLAGS[@]}" -d "${FILES[@]}"
  echo "shfmt OK (no diff)"
fi
