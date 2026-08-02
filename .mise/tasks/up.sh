#!/usr/bin/env bash
set -euo pipefail
#MISE description="Build and start the full stack (app + worker) with podman-compose"
#MISE alias="start"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

podman-compose up -d --build
echo
echo "Stack started: http://localhost:${PORT:-8080}"
podman-compose ps
