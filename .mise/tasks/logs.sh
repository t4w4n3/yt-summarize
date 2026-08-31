#!/usr/bin/env bash
set -euo pipefail
#MISE description="Follow container logs (default: app + worker)"
#USAGE arg "[service]" help="Compose service name(s), space-separated" default="app worker"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "logs" "$@"
trap 'metrics_end $?' EXIT

# Intentionally unquoted: $usage_service may contain multiple service names.
# shellcheck disable=SC2086
podman-compose logs -f $usage_service
