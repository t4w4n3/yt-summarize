#!/usr/bin/env bash
set -euo pipefail
#MISE description="Stop the stack (keeps the jobs DB and artifacts volumes)"
#MISE alias="stop"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

podman-compose down
