#!/usr/bin/env bash
set -euo pipefail
#MISE description="Back up both volumes (SQLite job DB + artifacts) to ~/.local/backups"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$HOME/.local/backups}"
KEEP="${BACKUP_KEEP:-10}"
mkdir -p "$BACKUP_DIR"

VOL_ROOT="$HOME/.local/share/containers/storage/volumes"
JOBS_VOL="$VOL_ROOT/summarize-yt_jobs-data/_data"
ART_VOL="$VOL_ROOT/summarize-yt_artifacts/_data"

for v in "$JOBS_VOL" "$ART_VOL"; do
  [ -d "$v" ] || { echo "Volume $v not found — is the stack up? Run \`mise run up\` first." >&2; exit 1; }
done

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/summarize-yt-$STAMP.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Consistent snapshot of SQLite while the app is running (WAL-safe; the
# restored jobs.db carries the full state — no -wal/-shm needed).
python3 - "$JOBS_VOL/jobs.db" "$TMP/jobs.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src)
d = sqlite3.connect(dst)
s.backup(d)
d.close(); s.close()
PY

tar czf "$ARCHIVE" -C "$TMP" jobs.db -C "$ART_VOL" .

# Prune old backups, keep the newest $KEEP.
ls -1t "$BACKUP_DIR"/summarize-yt-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

N_JOBS="$(python3 -c "
import sqlite3
db = sqlite3.connect('$TMP/jobs.db')
print(db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0])
")"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "Backed up $N_JOBS job(s) to $ARCHIVE ($SIZE), keeping the last $KEEP backups."
