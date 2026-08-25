#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run live tests that consume real API tokens (opt-in; needs the OpenRouter secret)"
#MISE alias="tl"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Live tests self-skip unless RUN_LIVE_TESTS=1; pnpm script sets it.
pnpm run test:live
