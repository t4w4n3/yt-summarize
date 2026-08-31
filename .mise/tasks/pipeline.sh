#!/usr/bin/env bash
set -euo pipefail
#MISE description="Submit a YouTube URL to the running stack and poll the job until done"
#USAGE arg "<url>" help="YouTube URL to summarize"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "pipeline" "$@"
trap 'metrics_end $?' EXIT
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

BASE="http://localhost:${PORT:-8080}"
URL="${usage_url:?}"

RESP="$(curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({url: process.argv[1]}))' "$URL")" \
  "$BASE/api/summarize")"

JOB_ID="$(printf '%s' "$RESP" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')"
if [ -z "$JOB_ID" ]; then
  echo "Unexpected response: $RESP" >&2
  exit 1
fi
echo "Submitted job $JOB_ID — polling (Ctrl-C to stop watching; the job keeps running)..."

while :; do
  JOB="$(curl --fail --silent --show-error "$BASE/api/jobs/$JOB_ID")"
  STATUS="$(printf '%s' "$JOB" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  STAGE="$(printf '%s' "$JOB" | sed -n 's/.*"stage":"\([^"]*\)".*/\1/p')"
  printf '\rstatus=%-6s stage=%-12s' "$STATUS" "${STAGE:-—}"
  case "$STATUS" in
    done) break ;;
    failed)
      ERROR="$(printf '%s' "$JOB" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
      echo
      echo "Job failed: ${ERROR:-unknown error}" >&2
      exit 1
      ;;
    *) : ;; # pending/running — keep polling
  esac
  sleep 2
done
echo
echo "Done. Markdown download: $BASE/api/jobs/$JOB_ID/result.md"
echo "Open the app:           $BASE"
