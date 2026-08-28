#!/usr/bin/env bash
set -euo pipefail
#MISE description="Measure code coverage per layer (domain + outbound adapters) via node's built-in test runner"
#MISE alias="cov"
#USAGE flag "-m --min-lines <pct>" help="Fail (exit 1) if any layer's line coverage is below <pct>"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm run coverage "$@"
