#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run every linter (JS/TS/JSON, shell, YAML, Containerfile, compose) — max strictness"
#USAGE flag "--fix" help="Auto-fix findings where the linter supports it"
#USAGE flag "--changed" help="Only lint uncommitted files (staged + unstaged + untracked)"
#USAGE flag "--fail-fast --ff" help="Stop at the first failing linter"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ARGS=()
[ "${usage_fix:-}" = "true" ] && ARGS+=(--fix)
[ "${usage_changed:-}" = "true" ] && ARGS+=(--changed)

status=0
for task in lint-types lint-js lint-shell lint-yaml lint-containerfile lint-compose; do
  echo "── mise run $task ${ARGS[*]:-}"
  if ! mise run "$task" ${ARGS+"${ARGS[@]}"}; then
    status=1
    if [ "${usage_fail_fast:-}" = "true" ]; then
      echo "fail-fast: stopping after '$task' failed" >&2
      break
    fi
  fi
done

if [ "$status" -ne 0 ]; then
  echo "lint FAILED (see output above)" >&2
  exit 1
fi
echo "all linters passed"
