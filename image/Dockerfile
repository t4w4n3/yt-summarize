# ---- Runtime (single stage; both paid stages are plain HTTPS calls to OpenRouter) ----
FROM node:24-bookworm-slim

# Versions pinned (hadolint DL3008/DL3013). Re-pin deliberately when bumping:
# `podman run --rm node:24-bookworm-slim bash -c "apt-get update && apt-cache policy <pkg>"`
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      ffmpeg=7:5.1.9-0+deb12u1 \
      gnupg=2.2.40-1.1+deb12u2 \
      iproute2=6.1.0-3 \
      procps=2:4.0.2-3 \
      python3=3.11.2-1+b1 \
      pipx=1.1.0-1 \
      wireguard-tools=1.0.20210914-1+b1 \
      bash=5.2.15-2+b13 \
    && rm -rf /var/lib/apt/lists/*

RUN pipx install --pip-args="--no-cache-dir" "yt-dlp==2026.8.19"
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
# Keep the pinned pnpm version in sync with mise.toml and package.json packageManager.
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.21.0 && pnpm install --frozen-lockfile --prod
COPY src/ /app/src/
COPY image/entrypoint-app.sh image/entrypoint-worker.sh image/entrypoint-vpn.sh /app/
RUN chmod +x /app/entrypoint-*.sh

EXPOSE 8080
