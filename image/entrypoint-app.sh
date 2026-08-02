#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${DATA_DIR:-/data}"
exec node /app/src/app/server.js
