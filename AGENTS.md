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
| `mise run test` | Full hermetic gate: typecheck + unit (domain, fakes) + arch (archunit) + integration (adapter boundaries) + e2e (no tokens; live excluded) |
| `mise run coverage [-m PCT]` | Measure per-layer code coverage (domain + outbound adapters) via node's built-in test runner; `-m PCT` fails if any layer's line coverage drops below PCT |
| `mise run test-live` | Live micro test that consumes real tokens (opt-in; needs the OpenRouter secret; `RUN_LIVE_TESTS=1`) |
| `mise run test-ui` | UI specs only (mocked API) |
| `mise run test-stack` | API + fake-worker specs only |
| `mise run test-containers` | Container smoke e2e: real image + fake worker via podman-compose (slow; needs podman) |
| `mise run mutation [--all] [--dry]` | Mutation testing via StrykerJS — `domain` POC by default (42 mutants, ~8s, `inPlace:true` for TS 7 compat), `--all` mutates `src/**` with `unit+integration` (slow), `--dry` verifies without mutating; HTML report `test-results/mutation/` |
| `mise run pipeline <url>` | Submit a YouTube URL to the running stack, poll until done |
| `mise run app [-p PORT]` | Run the web app locally (no container) |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run cookies <file>` | Install Netscape cookies.txt for the worker + restart it |
| `mise run mullvad <mode>` | Mullvad ops: relay rotation (`scan`), config provisioning (`init`), tunnel debug (`run`/`test`/`dryrun`) — the production path is the `vpn` sidecar, no `MULLVAD_ACCOUNT` needed for the interactive flow |
| `mise run backup` | Back up both volumes (SQLite job DB + artifacts) to `~/.local/backups` |
| `mise run restore <file> [-y]` | Restore both volumes from a `summarize-yt-*.tar.gz` backup (stops + restarts the stack) |
| `mise run lint [--fix] [--changed] [--fail-fast/-ff]` | Run every linter — tsc typecheck, Biome (JS/TS/JSON), shellcheck+shfmt (shell), yamllint strict, hadolint (Containerfile), podman-compose config |
| `mise run lint-types` | Typecheck all TypeScript with `tsc --noEmit` (strict, erasable-syntax-only) |
| `mise run lint-js [--fix] [--changed]` | Lint/format JS, TS and JSON with Biome (recommended rules + assist, error-on-warnings) |
| `mise run lint-shell [--fix] [--changed]` | shellcheck (`--severity=style --enable=all`) + shfmt formatting check on shell scripts |
| `mise run lint-yaml [--changed]` | yamllint in strict mode (warnings fail) on all YAML files |
| `mise run lint-containerfile [--changed]` | hadolint on Containerfiles/Dockerfiles (failure-threshold: style) |
| `mise run lint-compose [--changed]` | Validate compose files render with podman-compose |
| `mise run security` | Run every security check: pnpm audit, Trivy (vulns/secrets/misconfig), Gitleaks (working tree + git history) |
| `mise run check` | Full gate: doctor + lint + test + security |
| `mise run doctor` | Verify tools, Node ≥24, `.env`, GPG secrets |
| `mise run docs` | Serve the architecture/stack docs (Mermaid) at :8123; `--expose` publishes on the tailnet via `tailscale serve` (https 8443) |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `tl` (test-live), `tc` (test-containers).

## Notes for agents

- Tests: `mise run t` is the hermetic gate (`test:unit` → `tests/unit/**` domain use cases with fakes, `test:arch` → `tests/arch/**` via `archunit` layers, `test:integration` → `tests/integration/**` real adapter boundaries, `test:e2e` → `e2e/**` UI/stack). Token-consuming live tests live in `tests/live/**` and run only via `mise run test-live` (`RUN_LIVE_TESTS=1`, opt-in; skipped by the gate). Unit tests cover domain usecases through ports (fakes/mocks); integration tests exercise outbound adapters (real fs/process/HTTP stubbé); e2e Playwright mockent ou rejouent via le fake-worker ; `test-containers` hors gate. Artifacts go to `test-results/` (gitignored).
- Mutation: `mise run mutation` (alias `mut`) runs StrykerJS `command` runner (`node --test` natif, Node 24 type-stripping). Default mutates `src/domain/**` with `tests/unit/transcription-policy.test.ts` — POC 100% (42/42 killed). `--all` widens to `src/**` + `unit+integration`; `--dry` is dry-run. Reports `test-results/mutation/` + clear-text. Config `stryker.config.mjs` (`inPlace:true` contourne l'incompat TS 7 Go `ts.parseConfigFileTextToJson`). Thresholds `high 80 / low 60` informatifs (`break: null` non bloquant). Ajoute `.stryker-tmp/` (gitignored).
- Coverage: `mise run coverage` (alias `cov`) measures line/branch/function coverage per layer — `domain` (pure logic), `worker` (outbound stages + pipeline/bootstrap), `shared`, `vpn`, `app` — by running the hermetic unit+integration gate under `node --test --experimental-test-coverage` and parsing the `lcov` report (`scripts/coverage.ts` + pure LCOV parser `scripts/cov-parse.ts`). It re-runs the tests itself and exits non-zero if they fail; `-m PCT` additionally fails if any layer's line coverage drops below PCT. Parser unit tests live in `tests/unit/cov-parse.test.ts`.
- The stack runs via podman-compose; secrets are host GPG-encrypted at rest (`~/.secrets/openrouter.gpg` + `~/.gnupg`, 0600/0700) and synced into podman secrets (`openrouter_key`, `youtube_cookies` at `/run/secrets/*`, tmpfs 0440) via `scripts/sync-secrets.sh` (`mise run up` does it automatically) so the non-root `node` worker can read them despite rootless UID mapping — never put keys in `.env`. Legacy bind mount `/secrets/openrouter.gpg` + `/gnupg` is still read as fallback for OpenRouter (cookies use podman secret only). `app`/`worker` run as `node` (USER node), only `vpn` stays root (needs NET_ADMIN + /dev/net/tun, confined to its netns).
- YouTube downloads go through Mullvad via a `vpn` sidecar service (compose): it brings up the WireGuard tunnel in its own netns and exposes a loopback-only SOCKS5 proxy (127.0.0.1:1080). The worker's yt-dlp uses `--proxy socks5h://…` (`MULLVAD_ENABLED`/`MULLVAD_PROXY` in `.env`) — only yt-dlp's traffic exits via the tunnel. No host routes/firewall are touched; the tunnel never leaves the sidecar's network namespace. The WireGuard config lives at `~/.local/mullvad-poc/wg0.conf` (private key, 0600). Re-scan relays when YouTube starts blocking again: `mise run mullvad scan` (then `mise run mullvad init -i <addr> -r <relay>`).
- Local dev data dirs: `.local/` (gitignored).
- Raw commands (`podman-compose …`, `pnpm run …`) work, but task files are the documented interface.
