# AGENTS.md

Mise is the DevEx entrypoint. Every contributor action is a task file in `.mise/tasks/` (all `*.sh`, documented via `mise run <task> --help`). Run everything through `mise run <task>` — mise provides the pinned Node 24 toolchain (`mise.toml`).

## Quick start

```bash
mise run setup   # .env, pnpm install, Playwright browser (first time)
mise run up      # build + start the stack (app + worker) → http://localhost:8080
```

## Tasks

| Command | Description |
|---|---|
| `mise run setup` | One-time setup: `.env`, pnpm deps, Playwright browser |
| `mise run up` | Build + start the stack |
| `mise run build` | Build the image only |
| `mise run status` | `podman-compose ps` |
| `mise run logs [service]` | Follow logs (default: `app worker`) |
| `mise run down` | Stop the stack (keeps volumes) |
| `mise run clean [--yes]` | Stop + delete all data (`down -v`) |
| `mise run restart [service]` | Restart a service (default: `worker`) |
| `mise run test` | Full hermetic e2e suite (no YouTube/API keys) |
| `mise run test-ui` | UI specs only (mocked API) |
| `mise run test-stack` | API + fake-worker specs only |
| `mise run test-containers` | Container smoke e2e: real image + fake worker via podman-compose (slow; needs podman) |
| `mise run pipeline <url>` | Submit a YouTube URL to the running stack, poll until done |
| `mise run app [-p PORT]` | Run the web app locally (no container) |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run cookies <file>` | Install Netscape cookies.txt for the worker + restart it |
| `mise run mullvad <mode>` | Mullvad ops: relay rotation (`scan`), config provisioning (`init`), tunnel debug (`run`/`test`/`dryrun`) — the production path is the `vpn` sidecar, no `MULLVAD_ACCOUNT` needed for the interactive flow |
| `mise run backup` | Back up both volumes (SQLite job DB + artifacts) to `~/.local/backups` |
| `mise run restore <file> [-y]` | Restore both volumes from a `summarize-yt-*.tar.gz` backup (stops + restarts the stack) |
| `mise run lint [--fix] [--changed]` | Run every linter — Biome (JS/TS/JSON), shellcheck+shfmt (shell), yamllint strict, hadolint (Containerfile), podman-compose config |
| `mise run lint-js [--fix] [--changed]` | Lint/format JS, TS and JSON with Biome (recommended rules + assist, error-on-warnings) |
| `mise run lint-shell [--fix] [--changed]` | shellcheck (`--severity=style --enable=all`) + shfmt formatting check on shell scripts |
| `mise run lint-yaml [--changed]` | yamllint in strict mode (warnings fail) on all YAML files |
| `mise run lint-containerfile [--changed]` | hadolint on Containerfiles/Dockerfiles (failure-threshold: style) |
| `mise run lint-compose [--changed]` | Validate compose files render with podman-compose |
| `mise run security` | Run every security check: pnpm audit, Trivy (vulns/secrets/misconfig), Gitleaks (working tree + git history) |
| `mise run doctor` | Verify tools, Node ≥24, `.env`, GPG secrets |
| `mise run docs` | Serve the architecture/stack docs (Mermaid) at :8123; `--expose` publishes on the tailnet via `tailscale serve` (https 8443) |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `tc` (test-containers), `check` (doctor).

## Notes for agents

- Tests: `mise run t` (or `test-ui` / `test-stack`); artifacts go to `test-results/` (gitignored).
- The stack runs via podman-compose; secrets (`~/.secrets/openrouter.gpg`, `~/.gnupg`) are host GPG mounts, decrypted in worker memory — never put keys in `.env`.
- YouTube downloads go through Mullvad via a `vpn` sidecar service (compose): it brings up the WireGuard tunnel in its own netns and exposes a loopback-only SOCKS5 proxy (127.0.0.1:1080). The worker's yt-dlp uses `--proxy socks5h://…` (`MULLVAD_ENABLED`/`MULLVAD_PROXY` in `.env`) — only yt-dlp's traffic exits via the tunnel. No host routes/firewall are touched; the tunnel never leaves the sidecar's network namespace. The WireGuard config lives at `~/.local/mullvad-poc/wg0.conf` (private key, 0600). Re-scan relays when YouTube starts blocking again: `mise run mullvad scan` (then `mise run mullvad init -i <addr> -r <relay>`).
- Local dev data dirs: `.local/` (gitignored).
- Raw commands (`podman-compose …`, `pnpm run …`) work, but task files are the documented interface.
