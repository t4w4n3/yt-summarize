#!/usr/bin/env bash
set -euo pipefail
#MISE description="Full hermetic gate: typecheck + unit (domain) + arch + integration + e2e (no tokens)"
#MISE alias="t"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "test" "$@"
trap 'metrics_end $?' EXIT

pnpm run test
