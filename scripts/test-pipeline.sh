#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 <youtube-url>" >&2
  exit 1
fi

curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({url: process.argv[1]}))' "$URL")" \
  http://localhost:${PORT:-8080}/api/summarize
printf '\nPoll the returned jobId with GET /api/jobs/:id.\n'
