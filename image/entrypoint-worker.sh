#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/artifacts}"
mkdir -p "$DATA_DIR" "$ARTIFACTS_DIR"

# Secrets are delivered via podman secrets (tmpfs at /run/secrets/*, readable by `node`).
# Legacy bind mount /secrets/openrouter.gpg is still checked for backwards compat (openrouter only).
if [ ! -f /run/secrets/openrouter_key ] && [ ! -f /secrets/openrouter.gpg ]; then
  echo "WARNING: No OpenRouter credential found (/run/secrets/openrouter_key or /secrets/openrouter.gpg); paid stages will fail at key resolution." >&2
fi
if [ -f /run/secrets/openrouter_key ]; then
  # podman secret is tmpfs 0440; ensure the worker can read it (already world-readable)
  :
fi
# youtube cookies are optional — checked at /run/secrets/youtube_cookies
if [ -f /run/secrets/youtube_cookies ]; then
  # download.ts checks /run/secrets/youtube_cookies directly, so no action needed here
  :
fi

exec node /app/src/worker/worker.ts
