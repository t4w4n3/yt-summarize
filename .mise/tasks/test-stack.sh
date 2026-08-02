#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run only the stack e2e specs (real API + fake worker against SQLite)"
#MISE alias="test-stack"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

npm run test:e2e:stack
