# ---- Runtime multi-cible: un seul Dockerfile, trois images least-privilege ----
# Les trois services n'installent que les outils qu'ils spawkent vraiment :
#   app    : node + curl (healthcheck compose) — jamais yt-dlp/ffmpeg/wg
#   worker : node + yt-dlp/python + ffmpeg + gnupg + ca-certificates
#   vpn    : node + wireguard-tools/iproute2/bash (wg-quick) — jamais python/ffmpeg
# La base partage le socle (node slim + bash pour les entrypoints + deps pnpm)
# et le cache de couches, mais chaque cible finale garde sa surface minimale.
# Les stages payants sont de simples appels HTTPS à OpenRouter.

FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258 AS base

# bash est requis par les trois entrypoints (#/usr/bin/env bash) et par
# wg-quick côté vpn ; il vit donc dans la base partagée.
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

# ---- app: surface minimale, seul curl (healthcheck) en plus de bash ----
FROM base AS app
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl=8.14.1-2+deb13u7 \
    && rm -rf /var/lib/apt/lists/*
COPY image/entrypoint-app.sh /app/
RUN chmod +x /app/entrypoint-app.sh && chown -R node:node /app
EXPOSE 8080
# Healthcheck lives in compose.yaml (app service) — Dockerfile stays OCI-compatible
# without a HEALTHCHECK instruction (which triggers "HEALTHCHECK is not supported
# for OCI image format" warnings under podman/buildah default format).
# `node` (uid 1000) is defined in the base image /etc/passwd and referenced the
# same way in compose.yaml; numeric would lose readability.
# hadolint ignore=DL3066
USER node

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
