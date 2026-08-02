#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/artifacts}"
mkdir -p "$DATA_DIR" "$ARTIFACTS_DIR"

# Keep the host-mounted keyring read-only. GnuPG needs a writable home for sockets and metadata.
export GNUPGHOME="${GNUPGHOME:-/run/gnupg}"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
if [ -d /gnupg ]; then
  cp -a /gnupg/. "$GNUPGHOME/"
  chmod -R go-rwx "$GNUPGHOME" || true
fi

if [ ! -f /secrets/openrouter.gpg ]; then
  echo "WARNING: /secrets/openrouter.gpg is missing; paid stages will fail at key resolution." >&2
fi

exec node /app/src/worker/worker.js
