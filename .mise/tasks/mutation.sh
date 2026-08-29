#!/usr/bin/env bash
set -euo pipefail
#MISE description="Mutation testing via StrykerJS (POC domain by default, hermetic)"
#MISE alias="mut"
#USAGE flag "-a --all" help="Mutate domain+shared+worker (unit+integration, ~3-6 min)"
#USAGE flag "--shared" help="Mutate src/shared/** only"
#USAGE flag "--worker" help="Mutate src/worker/** only"
#USAGE flag "--dry" help="Dry run only — verify Stryker can run the suite without mutating"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# gitleaks / CI guards ignore .stryker-tmp and test-results/mutation
if [ "${usage_all:-false}" = "true" ]; then
  echo "→ mutation: domain+shared+worker (unit+integration)"
  exec npx stryker run --mutate "src/domain/**/*.ts,src/shared/**/*.ts,src/worker/**/*.ts"
elif [ "${usage_shared:-false}" = "true" ]; then
  echo "→ mutation: src/shared/**"
  exec npx stryker run --mutate "src/shared/**/*.ts"
elif [ "${usage_worker:-false}" = "true" ]; then
  echo "→ mutation: src/worker/**"
  exec npx stryker run --mutate "src/worker/**/*.ts"
elif [ "${usage_dry:-false}" = "true" ]; then
  echo "→ mutation: dry run (domain POC, no mutants)"
  exec pnpm run mutation:dry
else
  echo "→ mutation: domain POC (src/domain/** + tests/unit/transcription-policy.test.ts)"
  echo "  use --all for full src/, --dry for dry-run"
  exec pnpm run mutation
fi
