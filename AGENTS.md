# AGENTS.md

Mise is the DevEx entrypoint. Every contributor action is a task file in `.mise/tasks/` (all `*.sh`, documented via `mise run <task> --help`). Run everything through `mise run <task>` — mise provides the pinned Node 24 toolchain (`mise.toml`).

## Quick start

```bash
mise run setup   # .env, npm ci, Playwright browser (first time)
mise run up      # build + start the stack (app + worker) → http://localhost:8080
```

## Tasks

| Command | Description |
|---|---|
| `mise run setup` | One-time setup: `.env`, npm deps, Playwright browser |
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
| `mise run doctor` | Verify tools, Node ≥24, `.env`, GPG secrets |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `tc` (test-containers), `check` (doctor).

## Notes for agents

- Tests: `mise run t` (or `test-ui` / `test-stack`); artifacts go to `test-results/` (gitignored).
- The stack runs via podman-compose; secrets (`~/.secrets/openrouter.gpg`, `~/.gnupg`) are host GPG mounts, decrypted in worker memory — never put keys in `.env`.
- Local dev data dirs: `.local/` (gitignored).
- Raw commands (`podman-compose …`, `npm run …`) work, but task files are the documented interface.
