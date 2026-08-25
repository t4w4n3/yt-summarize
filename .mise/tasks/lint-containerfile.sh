#!/usr/bin/env bash
set -euo pipefail
#MISE description="hadolint on Containerfiles/Dockerfiles (failure-threshold: style)"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE arg "[files]" var=#true help="Containerfile/Dockerfile paths (default: all tracked)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lint-lib.sh"

MODE=all
[ "${usage_changed:-}" = "true" ] && MODE=--changed

FILES=()
if [ -n "${usage_files:-}" ]; then
  read -r -a FILES <<<"$usage_files"
else
  mapfile -t FILES < <(lint_list_files containerfile "$MODE")
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no Containerfiles/Dockerfiles"
  exit 0
fi

# .hadolint.yaml sets failure-threshold: style → even style findings fail.
hadolint "${FILES[@]}"
echo "containerfile lint OK (${#FILES[@]} file(s))"
