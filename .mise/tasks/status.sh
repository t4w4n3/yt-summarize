#!/usr/bin/env bash
set -euo pipefail
#MISE description="Show the stack's container status"
#MISE alias="ps"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

podman-compose ps
