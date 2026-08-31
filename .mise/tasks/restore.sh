#!/usr/bin/env bash
set -euo pipefail
#MISE description="Restore both volumes from a backup archive (stops the stack, restores, restarts)"
#USAGE arg "<file>" help="Path to a summarize-yt-*.tar.gz backup"
#USAGE flag "-y --yes" help="Skip the confirmation prompt"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "restore" "$@"

ARCHIVE="${usage_file:?Usage: mise run restore <backup.tar.gz> [--yes]}"
[ -f "$ARCHIVE" ] || {
  echo "No such file: $ARCHIVE" >&2
  exit 1
}
tar tzf "$ARCHIVE" 2>/dev/null | grep -qx 'jobs.db' || {
  echo "$ARCHIVE does not look like a summarize-yt backup (missing jobs.db)." >&2
  exit 1
}

if [ "${usage_yes:-false}" != "true" ]; then
  read -r -p "This REPLACES the jobs database and every artifact with the backup. Type 'restore' to confirm: " answer
  if [ "$answer" != "restore" ]; then
    echo "Aborted."
    exit 1
  fi
fi

VOL_ROOT="$HOME/.local/share/containers/storage/volumes"
JOBS_VOL="$VOL_ROOT/summarize-yt_jobs-data/_data"
ART_VOL="$VOL_ROOT/summarize-yt_artifacts/_data"
TMP="$(mktemp -d)"
trap 'rc=$?; metrics_end $rc; rm -rf "$TMP"' EXIT

echo "[restore] stopping the stack (containers may stay down if they don't exist)..."
podman-compose stop >/dev/null 2>&1 || true

tar xzf "$ARCHIVE" -C "$TMP"

find "$JOBS_VOL" -mindepth 1 -delete 2>/dev/null || true
mkdir -p "$JOBS_VOL"
cp "$TMP/jobs.db" "$JOBS_VOL/jobs.db"

find "$ART_VOL" -mindepth 1 -delete 2>/dev/null || true
mkdir -p "$ART_VOL"
cp -a "$TMP"/. "$ART_VOL"/

# Start existing containers if present; create them otherwise. `up -d` alone
# would try to recreate stopped containers and spew "name already in use" noise.
if podman ps -a --format '{{.Names}}' | grep -qx 'summarize-yt_app_1'; then
  echo "[restore] starting the stack..."
  podman-compose start
else
  echo "[restore] creating and starting the stack..."
  podman-compose up -d
fi

N_JOBS="$(python3 -c "
import sqlite3
db = sqlite3.connect('$JOBS_VOL/jobs.db')
print(db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0])
")"
echo "Restored $N_JOBS job(s) from $ARCHIVE."
