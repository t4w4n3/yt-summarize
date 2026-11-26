# ---- Runtime multi-cible: un seul Dockerfile, trois images least-privilege ----
# Les trois services n'installent que les outils qu'ils spawkent vraiment :
#   app    : distroless Node, zero shell, zero curl (ENTRYPOINT node, CMD healthcheck)
#   worker : node + yt-dlp/python + ffmpeg + ca-certificates (entrypoint Node, no gnupg)
#   vpn    : node + wireguard-tools/iproute2/bash (wg-quick) — jamais python/ffmpeg
# La base partage le socle build (node slim + deps pnpm) et le cache de
# couches, mais chaque cible finale garde sa surface minimale. Ni le worker
# ni le vpn ne descendent de `base` (outillage pnpm + arbre app/worker) :
# voir leurs stages.
# Les stages payants sont de simples appels HTTPS à OpenRouter.

FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258 AS base

# bash n'est plus installé ici : seul le vpn en a besoin (wg-quick est un
# script bash), et il ne descend plus de `base` (voir son stage) — il
# l'installe lui-même. Le worker n'en dépend plus non plus (entrypoint Node).
# `base` ne sert plus qu'à builder l'arbre /app copié par app et worker.

WORKDIR /app
# Keep the pinned pnpm version in sync with mise.toml and package.json packageManager.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@12.23.0 && pnpm install --frozen-lockfile --prod

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

# ---- worker: yt-dlp/python + ffmpeg + ca-certificates (entrypoint Node, no gnupg) ----
# Not FROM base: base carries the vpn bash + pnpm build tooling. The worker
# only needs the copied /app tree plus its three tools, so it starts from the
# same pinned slim base directly and copies /app from `base` — no pipx and
# no gnupg at runtime, and its entrypoint is Node (no shell in the boot path).
# Caveat: Debian slim ships /bin/bash + /bin/sh as essential packages, so a
# shell binary is present in the image regardless; a truly shell-less worker
# would need a distroless binary-copy image (see todo.md).
# pipx is build-only: it installs yt-dlp into /opt/pipx (a venv the runtime
# python3 executes) and is then purged in the same layer, so it does not ship.
FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258 AS worker
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates=20250419+deb13u1 \
      ffmpeg=7:7.1.5-0+deb13u1 \
      python3=3.13.5-1 \
      pipx=1.7.1-1 \
    && PIPX_HOME="/opt/pipx" PIPX_BIN_DIR="/usr/local/bin" pipx install --pip-args="--no-cache-dir" "yt-dlp==2026.10.26" \
    && apt-get purge -y pipx \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=base /app /app
RUN mkdir -p /data /artifacts && chown -R node:node /app /data /artifacts
# hadolint ignore=DL3066
USER node

# ---- vpn: wireguard-tools + iproute2 + bash (wg-quick) + Node (SOCKS5) only ----
# Not FROM base: base ships the whole app/worker tree (domain, application,
# infrastructure incl. the OpenRouter secret store, express node_modules,
# pnpm/npm). The sidecar only needs node to run src/vpn/*.ts (Node built-ins
# only — no dependency, so nothing to install) plus wg-quick for the tunnel:
# bash (wg-quick is a bash script that also evals the Mullvad PostUp/PreDown
# hooks) and awk, already in the slim base, for the PostUp route lookup. It
# therefore starts from the same pinned slim base as the worker and copies
# src/vpn only. npm is purged: the runtime only needs the node binary itself.
# Versions épinglées (hadolint DL3008) — voir la note sur `base`.
FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258 AS vpn
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash=5.2.37-2+b10 \
      iproute2=6.15.0-1 \
      wireguard-tools=1.0.20210914-3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY src/vpn/ /app/src/vpn/
RUN chown -R node:node /app
# Image stays non-root (USER node, like the others) so DS-0002 passes: the privilege
# grant happens in compose.yaml (`user: root`, only for vpn — needs NET_ADMIN +
# /dev/net/tun, confined to its own netns) and in scripts (podman run --user root).
# hadolint ignore=DL3066
USER node
