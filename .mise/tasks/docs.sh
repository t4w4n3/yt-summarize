#!/usr/bin/env bash
set -euo pipefail
#MISE description="Serve the architecture docs (Mermaid diagrams) — http://localhost:8123"
#MISE alias="docs"
#USAGE flag "-b --background" help="Run the server in the background (stop with: mise run docs stop)"
#USAGE flag "-e --expose" help="Expose on the tailnet via tailscale serve: https://<machine>.ts.net:8443"
#USAGE flag "-p --port <port>" help="Local listen port" default="8123" env="DOCS_PORT"
#USAGE arg "[stop]" help="Stop the background docs server and unexpose it"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DOCS_PORT="${usage_port}"
DOCS_HOST="127.0.0.1"
HTTPS_PORT=8443
PID_FILE=".local/docs-server.pid"
LOG_FILE=".local/docs-server.log"
TAILSCALE_URL="https://<machine>.ts.net:${HTTPS_PORT}/"

stop_server() {
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null && echo "Stopped docs server (pid $PID)."
    else
      echo "Docs server was not running (stale pid file)."
    fi
    rm -f "$PID_FILE"
  fi
}

unexpose() {
  # Unconditional removal: `off` on an absent handler is a no-op (exit 1, no harm).
  sudo tailscale serve --https="${HTTPS_PORT}" off >/dev/null 2>&1 || true
  echo "Removed tailscale serve config for :${HTTPS_PORT} (if present)."
}

if [ "${1:-}" = "stop" ]; then
  stop_server
  unexpose
  exit 0
fi

mkdir -p .local
stop_server # avoid a stale server on a different port

if [ "${usage_background:-false}" = "true" ]; then
  nohup node scripts/docs-server.mjs >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "docs server failed to start — log: $LOG_FILE" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  echo "Docs server running in background (pid $(cat "$PID_FILE")) → http://${DOCS_HOST}:${DOCS_PORT}/"
else
  echo "Serving on http://${DOCS_HOST}:${DOCS_PORT}/  (Ctrl-C to stop)"
  DOCS_PORT="$DOCS_PORT" node scripts/docs-server.mjs
  exit 0
fi

if [ "${usage_expose:-false}" = "true" ]; then
  echo "Exposing on the tailnet via tailscale serve…"
  tailscale serve --bg --https="${HTTPS_PORT}" "http://${DOCS_HOST}:${DOCS_PORT}" 2>&1 | sed 's/^/  /'
  echo "→ $TAILSCALE_URL  (remove with: mise run docs stop)"
fi
