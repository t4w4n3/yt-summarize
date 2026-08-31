#!/usr/bin/env bash
set -euo pipefail
#MISE description="Build and start the full stack (app + worker) with podman-compose"
#MISE alias="start"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "up" "$@"
trap 'metrics_end $?' EXIT
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# Sync GPG-encrypted host secrets into podman secrets (tmpfs, rootless-friendly).
# The worker now reads /run/secrets/openrouter_key instead of a bind mount, so
# non-root `node` can read it despite rootless UID mapping. Creates placeholders
# when the GPG source is absent so compose's `external: true` does not fail.
if [ -x "$ROOT/scripts/sync-secrets.sh" ]; then
  "$ROOT/scripts/sync-secrets.sh" || echo "WARNING: sync-secrets failed; worker may lack credentials" >&2
fi

# Existing named volumes created before the rootless migration are owned by the
# host user (uid 1000, 0755) and are not writable for container `node` (mapped
# to 100999). Chown them to the container user via `podman unshare` (idempotent
# for fresh volumes already owned by 100999). Ignore errors on fresh installs
# where volumes do not yet exist.
for vol in summarize-yt_jobs-data summarize-yt_artifacts; do
  mp="$(podman volume inspect "$vol" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [ -n "$mp" ] && [ -d "$mp" ]; then
    podman unshare chown -R 1000:1000 "$mp" 2>/dev/null || true
    podman unshare chmod 777 "$mp" 2>/dev/null || true
  fi
done

# --force-recreate évite "container name already in use" sur les re-runs
# idempotents : podman-compose 1.3.0 tente un create même quand l'image
# n'a pas changé, ce qui sort 3 erreurs rouges alors que l'opération est
# légitime. --remove-orphans nettoie les orphelins sans bruit.
# CACHE_BUST force l'invalidation du layer COPY src/ quand HEAD bouge
# (le cache podman réutilisait l'ancien src même après git pull).
CACHE_BUST="$(git rev-parse HEAD 2>/dev/null || date +%s)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  CACHE_BUST="${CACHE_BUST}-dirty-$(git status --porcelain 2>/dev/null | sha256sum | cut -c1-8)"
fi
podman-compose up -d --build --build-arg "CACHE_BUST=${CACHE_BUST}" --force-recreate --remove-orphans
echo
echo "Stack started: http://localhost:${PORT:-8080}"
podman-compose ps
