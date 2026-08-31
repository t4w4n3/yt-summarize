#!/usr/bin/env bash
set -euo pipefail
#MISE description="Full gate: doctor + lint + test + security"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "check" "$@"
trap 'metrics_end $?' EXIT

status=0
for task in doctor lint test security; do
  echo "── mise run $task"
  mise run "$task" || status=1
done

if [ "$status" -ne 0 ]; then
  echo "check FAILED (see output above)" >&2
  exit 1
fi
echo "all checks passed (doctor, lint, test, security)"
