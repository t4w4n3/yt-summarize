#!/usr/bin/env bash
set -euo pipefail
#MISE description="Mutation testing via StrykerJS (POC domain by default, hermetic)"
#MISE alias="mut"
#USAGE flag "-a --all" help="Mutate all src/** (slow, ~5-10 min)"
#USAGE flag "--dry" help="Dry run only — verify Stryker can run the suite without mutating"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# gitleaks / CI guards ignore .stryker-tmp and test-results/mutation
ARGS=()
if [ "${usage_all:-false}" = "true" ]; then
  echo "→ mutation: all src/** (integration + unit)"
  ARGS=(--mutate "src/**/*.ts" --commandRunner.command "node --test 'tests/unit/**/*.test.ts' 'tests/integration/**/*.test.ts'")
elif [ "${usage_dry:-false}" = "true" ]; then
  echo "→ mutation: dry run (domain POC, no mutants)"
  exec pnpm run mutation:dry
else
  echo "→ mutation: domain POC (src/domain/** + tests/unit/transcription-policy.test.ts)"
  echo "  use --all for full src/, --dry for dry-run"
fi

exec pnpm run mutation -- "${ARGS[@]}"
