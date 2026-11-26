#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run the web app locally (no container) for UI/API iteration"
#USAGE flag "-p --port <port>" help="Listen port" default="8080" env="PORT"
#USAGE flag "--host <addr>" help="Bind address (default 127.0.0.1; 0.0.0.0 exposes on the LAN)" default="127.0.0.1" env="HOST"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "app" "$@"
trap 'metrics_end $?' EXIT

DATA_DIR="${DATA_DIR:-.local/data}"
mkdir -p "$DATA_DIR"
echo "App: http://localhost:${usage_port}/  (jobs DB in $DATA_DIR)"
PORT="${usage_port}" HOST="${usage_host}" DATA_DIR="$DATA_DIR" node src/infrastructure/inbound/http.ts
