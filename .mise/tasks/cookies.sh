#!/usr/bin/env bash
set -euo pipefail
#MISE description="Install YouTube cookies for the worker and restart it (Netscape cookies.txt)"
#USAGE arg "<file>" help="Path to a Netscape-format cookies.txt from a signed-in browser"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SRC="${usage_file:?}"
DEST="$HOME/.secrets/youtube-cookies.txt"

mkdir -p "$HOME/.secrets"
install -m 600 "$SRC" "$DEST"
echo "Installed $DEST"
podman-compose restart worker
echo "Worker restarted; yt-dlp will pass --cookies when the file is present."
