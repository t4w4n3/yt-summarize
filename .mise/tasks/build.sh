#!/usr/bin/env bash
set -euo pipefail
#MISE description="Build the container image only (no restart)"
#MISE alias="b"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "build" "$@"
trap 'metrics_end $?' EXIT

CACHE_BUST="$(git rev-parse HEAD 2>/dev/null || date +%s)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  CACHE_BUST="${CACHE_BUST}-dirty-$(git status --porcelain 2>/dev/null | sha256sum | cut -c1-8)"
fi
podman-compose build --build-arg "CACHE_BUST=${CACHE_BUST}"
