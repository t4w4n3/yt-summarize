# ---- Runtime (single stage; both paid stages are plain HTTPS calls to OpenRouter) ----
FROM node:26.13.1-trixie-slim@sha256:a5a5adfee3013de54504e0e6aff49993acf7daed072e86be75b8818c0f6ac258

# Versions pinned (hadolint DL3008/DL3013). Re-pin deliberately when bumping:
# `podman run --rm node:26-trixie-slim bash -c "apt-get update && apt-cache policy <pkg>"`
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates=20250419+deb13u1 \
      curl=8.14.1-2+deb13u7 \
      ffmpeg=7:7.1.5-0+deb13u1 \
      gnupg=2.4.7-21+deb13u1 \
      iproute2=6.15.0-1 \
      procps=2:4.0.4-9 \
      python3=3.13.5-1 \
      pipx=1.7.1-1 \
      wireguard-tools=1.0.20210914-3 \
      bash=5.2.37-2+b10 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp as a global binary so it stays on PATH for the non-root `node` user
ENV PIPX_HOME="/opt/pipx"
ENV PIPX_BIN_DIR="/usr/local/bin"
RUN pipx install --pip-args="--no-cache-dir" "yt-dlp==2026.10.26"

WORKDIR /app
# Keep the pinned pnpm version in sync with mise.toml and package.json packageManager.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@12.21.0 && pnpm install --frozen-lockfile --prod

RUN mkdir -p /data /artifacts && chown -R node:node /app /data /artifacts
# Bust cache when git HEAD moves so `COPY src/` is never stale (podman layer cache bug).
ARG CACHE_BUST=""
COPY src/ /app/src/
COPY image/entrypoint-app.sh image/entrypoint-worker.sh image/entrypoint-vpn.sh /app/
RUN chmod +x /app/entrypoint-*.sh && chown -R node:node /app

EXPOSE 8080
# Healthcheck lives in compose.yaml (app service) — Dockerfile stays OCI-compatible
# without a HEALTHCHECK instruction (which triggers "HEALTHCHECK is not supported
# for OCI image format" warnings under podman/buildah default format).
# `node` (uid 1000) is defined in the base image /etc/passwd and referenced the
# same way in compose.yaml; numeric would lose readability.
# hadolint ignore=DL3066
USER node
