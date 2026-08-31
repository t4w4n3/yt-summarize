#!/usr/bin/env bash
set -euo pipefail
#MISE description="Show the stack's container status"
#MISE alias="ps"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "status" "$@"
trap 'metrics_end $?' EXIT

podman-compose ps
