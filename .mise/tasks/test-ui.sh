#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run only the UI e2e specs (mocked API; no servers needed)"
#MISE alias="test-ui"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm run test:e2e:ui
