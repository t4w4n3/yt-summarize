# ---- Runtime (single stage; both paid stages are plain HTTPS calls to OpenRouter) ----
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg gnupg iproute2 procps python3 pipx wireguard-tools bash \
    && rm -rf /var/lib/apt/lists/*

RUN pipx install --pip-args="--no-cache-dir" "yt-dlp"
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
# Keep the pinned pnpm version in sync with mise.toml and package.json packageManager.
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.21.0 && pnpm install --frozen-lockfile --prod
COPY src/ /app/src/
COPY image/entrypoint-app.sh image/entrypoint-worker.sh image/entrypoint-vpn.sh /app/
RUN chmod +x /app/entrypoint-*.sh

EXPOSE 8080
