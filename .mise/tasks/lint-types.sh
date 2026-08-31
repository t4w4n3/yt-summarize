#!/usr/bin/env bash
set -euo pipefail
#MISE description="Typecheck all TypeScript with tsc --noEmit (strict, erasable-syntax-only)"
#USAGE arg "[files]" var=#true help="Accepted for symmetry with the other lint tasks; typechecking is always whole-project"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "lint-types" "$@"
trap 'metrics_end $?' EXIT

pnpm run typecheck
echo "typecheck OK"
