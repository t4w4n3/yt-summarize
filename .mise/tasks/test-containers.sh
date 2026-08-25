#!/usr/bin/env bash
set -euo pipefail
#MISE description="Container smoke e2e: real image + fake worker via podman-compose (slow; needs podman)"
#MISE alias="tc"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v podman-compose >/dev/null 2>&1 || { echo "podman-compose required — run \`mise run doctor\`" >&2; exit 1; }

# podman-compose 1.3.0 chdirs into the compose file's directory and then re-opens
# -f paths — a relative path into a subdirectory breaks (e2e/e2e/...). Pass
# absolute so volumes/context inside the file still resolve against e2e/.
COMPOSE=(podman-compose -p summarize-yt-e2e -f "$ROOT/e2e/compose.e2e.yaml")
E2E_PORT="${E2E_PORT:-4174}"
E2E_WORKER_PORT="${E2E_WORKER_PORT:-4175}"

# Fresh job store. The data dir is bind-mounted (not a named volume), so
# `down -v` won't remove it — wipe before the containers start, never after.
rm -rf e2e/.tmp/data

cleanup() {
  echo "[test-containers] tearing down the stack..."
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[test-containers] building image + starting stack (first run builds the image; be patient)..."
"${COMPOSE[@]}" up -d --build

echo "[test-containers] waiting for app on http://127.0.0.1:${E2E_PORT}/ ..."
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${E2E_PORT}/" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && { echo "app did not become healthy in time" >&2; exit 1; }
  sleep 2
done

echo "[test-containers] waiting for fake worker on http://127.0.0.1:${E2E_WORKER_PORT}/healthz ..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${E2E_WORKER_PORT}/healthz" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && { echo "worker did not become healthy in time" >&2; exit 1; }
  sleep 2
done

echo "[test-containers] running stack specs against the container stack..."
export E2E_PORT E2E_WORKER_PORT
pnpm run test:e2e:containers
