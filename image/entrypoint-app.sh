#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${DATA_DIR:-/data}"
exec node /app/src/infrastructure/inbound/http.ts
