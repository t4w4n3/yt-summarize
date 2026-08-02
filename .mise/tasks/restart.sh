#!/usr/bin/env bash
set -euo pipefail
#MISE description="Restart a service (default: worker; needed after installing cookies)"
#USAGE arg "[service]" help="Compose service name" default="worker"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

podman-compose restart "$usage_service"
