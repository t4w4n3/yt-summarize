#!/usr/bin/env bash
set -euo pipefail
#MISE description="Build the container image only (no restart)"
#MISE alias="b"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

podman-compose build
