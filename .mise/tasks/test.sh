#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run the full Playwright e2e suite (hermetic UI + stack; no YouTube/API keys)"
#MISE alias="t"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm run test:e2e
