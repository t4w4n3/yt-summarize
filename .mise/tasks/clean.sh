#!/usr/bin/env bash
set -euo pipefail
#MISE description="Stop the stack and DELETE all data (jobs DB + artifacts)"
#USAGE flag "-y --yes" help="Skip the confirmation prompt"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "${usage_yes:-false}" != "true" ]; then
  read -r -p "This deletes the jobs database and every artifact. Type 'clean' to confirm: " answer
  if [ "$answer" != "clean" ]; then
    echo "Aborted."
    exit 1
  fi
fi

podman-compose down -v
