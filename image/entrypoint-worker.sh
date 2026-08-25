#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/artifacts}"
mkdir -p "$DATA_DIR" "$ARTIFACTS_DIR"

# Secrets are delivered via podman secrets (tmpfs at /run/secrets/*, readable by `node`).
# Legacy bind mounts (/secrets/*) are still checked for backwards compat during migration.
if [ ! -f /run/secrets/openrouter_key ] && [ ! -f /secrets/openrouter.gpg ]; then
  echo "WARNING: No OpenRouter credential found (/run/secrets/openrouter_key or /secrets/openrouter.gpg); paid stages will fail at key resolution." >&2
fi
if [ -f /run/secrets/openrouter_key ]; then
  # podman secret is tmpfs 0440; ensure the worker can read it (already world-readable)
  :
fi
# youtube cookies are optional — check both the secret and the legacy bind mount path
if [ -f /run/secrets/youtube_cookies ]; then
  # expose as /tmp/cookies for yt-dlp; podman secret is 0440 so copy to a readable location
  # download.js checks /run/secrets/youtube_cookies directly, so no action needed here
  :
fi

exec node /app/src/worker/worker.js
