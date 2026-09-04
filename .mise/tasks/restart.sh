#!/usr/bin/env bash
set -euo pipefail
#MISE description="Restart a service (default: worker)"
#USAGE arg "[service]" help="Compose service name" default="worker"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "restart" "$@"
trap 'metrics_end $?' EXIT

podman-compose restart "$usage_service"
