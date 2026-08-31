#!/usr/bin/env bash
set -euo pipefail
#MISE description="Install YouTube cookies for the worker and restart it (Netscape cookies.txt)"
#USAGE arg "<file>" help="Path to a Netscape-format cookies.txt from a signed-in browser"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "cookies" "$@"
trap 'metrics_end $?' EXIT

SRC="${usage_file:?}"
DEST="$HOME/.secrets/youtube-cookies.txt"

mkdir -p "$HOME/.secrets"
install -m 600 "$SRC" "$DEST"
echo "Installed $DEST"
# Sync the cookies file into a podman secret so the non-root worker can read it
# (bind mount via podman secret tmpfs, not host UID). The worker checks
# /run/secrets/youtube_cookies first, then the legacy /secrets path.
if [ -x "$ROOT/scripts/sync-secrets.sh" ]; then
  "$ROOT/scripts/sync-secrets.sh" || echo "WARNING: sync-secrets failed" >&2
elif command -v podman >/dev/null 2>&1; then
  podman secret rm youtube_cookies >/dev/null 2>&1 || true
  podman secret create youtube_cookies "$DEST" >/dev/null && echo "podman secret 'youtube_cookies' synced"
fi
podman-compose restart worker
echo "Worker restarted; yt-dlp will pass --cookies when the file is present."
