#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run only the UI e2e specs (mocked API; no servers needed)"
#MISE alias="test-ui"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "test-ui" "$@"
trap 'metrics_end $?' EXIT

pnpm run test:e2e:ui
