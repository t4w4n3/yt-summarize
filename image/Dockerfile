# ---- Runtime multi-cible: un seul Dockerfile, trois images least-privilege ----
# Les trois services n'installent que les outils qu'ils spawkent vraiment :
#   app    : distroless Node, zero shell, zero curl (ENTRYPOINT node, CMD healthcheck)
#   worker : node + yt-dlp/python + ffmpeg + gnupg + ca-certificates
#   vpn    : node + wireguard-tools/iproute2/bash (wg-quick) — jamais python/ffmpeg
# La base partage le socle (node slim + bash pour les entrypoints worker/vpn + deps pnpm)
# et le cache de couches, mais chaque cible finale garde sa surface minimale.
# Les stages payants sont de simples appels HTTPS à OpenRouter.

FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258 AS base

# bash est requis par les entrypoints worker/vpn (#/usr/bin/env bash) et par
# wg-quick côté vpn ; il vit donc dans la base partagée (et le builder app).
# Versions épinglées (hadolint DL3008/DL3013). Re-épingler délibérément :
# `podman run --rm node:26-trixie-slim bash -c "apt-get update && apt-cache policy <pkg>"`
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash=5.2.37-2+b10 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Keep the pinned pnpm version in sync with mise.toml and package.json packageManager.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@12.21.0 && pnpm install --frozen-lockfile --prod

RUN mkdir -p /data /artifacts && chown -R node:node /app /data /artifacts
# Bust cache when git HEAD moves so `COPY src/` is never stale (podman layer cache bug).
ARG CACHE_BUST=""
COPY src/ /app/src/
RUN chown -R node:node /app

# ---- app: distroless Node (zero shell, zero curl) ----
# The slim `base` above is only a builder (pnpm install + src); the app runtime is
# distroless nodejs26 (same Node v26.13.1) with no /bin/sh and no curl. Two consequences
# (guarded by the arch test): no shell entrypoint — ENTRYPOINT/CMD run node directly,
# and the old `mkdir -p /data` is already done by job-store (fs.mkdirSync).
# UID 1000 explicit: distroless has no `node` user, but the app must keep uid 1000 to
# share the jobs-data volume with the worker (USER node = uid 1000 in the slim images).
FROM gcr.io/distroless/nodejs26-debian13@sha256:521609dbb1ecdefd4c4f2bd25425b51b0b063f9f3935b80f6194a16e1a999f95 AS app
COPY --from=base /app /app
COPY --from=base --chown=1000:1000 /data /data
WORKDIR /app
EXPOSE 8080
# No Dockerfile HEALTHCHECK (OCI-incompatible): the compose-level CMD healthcheck
# (node healthcheck.ts, no shell) lives in compose.yaml.
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/src/infrastructure/inbound/http.ts"]
USER 1000

# ---- worker: yt-dlp/python + ffmpeg + gnupg + ca-certificates ----
FROM base AS worker
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates=20250419+deb13u1 \
      ffmpeg=7:7.1.5-0+deb13u1 \
      gnupg=2.4.7-21+deb13u1 \
      python3=3.13.5-1 \
      pipx=1.7.1-1 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp as a global binary so it stays on PATH for the non-root `node` user
ENV PIPX_HOME="/opt/pipx"
ENV PIPX_BIN_DIR="/usr/local/bin"
RUN pipx install --pip-args="--no-cache-dir" "yt-dlp==2026.10.26"

COPY image/entrypoint-worker.sh /app/
RUN chmod +x /app/entrypoint-worker.sh && chown -R node:node /app
# hadolint ignore=DL3066
USER node

# ---- vpn: wireguard-tools + iproute2 (wg-quick) uniquement ----
FROM base AS vpn
RUN apt-get update && apt-get install -y --no-install-recommends \
      iproute2=6.15.0-1 \
      wireguard-tools=1.0.20210914-3 \
    && rm -rf /var/lib/apt/lists/*
COPY image/entrypoint-vpn.sh /app/
RUN chmod +x /app/entrypoint-vpn.sh
# Image stays non-root (USER node, like the others) so DS-0002 passes: the privilege
# grant happens in compose.yaml (`user: root`, only for vpn — needs NET_ADMIN +
# /dev/net/tun, confined to its own netns) and in scripts (podman run --user root).
# hadolint ignore=DL3066
USER node
