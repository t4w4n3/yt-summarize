#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run only the stack e2e specs (real API + fake worker against SQLite)"
#MISE alias="test-stack"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "test-stack" "$@"
trap 'metrics_end $?' EXIT

pnpm run test:e2e:stack
