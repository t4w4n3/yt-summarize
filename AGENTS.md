# AGENTS.md

Mise is the DevEx entrypoint. Every contributor action is a task file in `.mise/tasks/` (all `*.sh`, documented via `mise run <task> --help`). Run everything through `mise run <task>` — mise provides the pinned Node 24 toolchain (`mise.toml`).

Operator-oriented docs (setup, usage, API, architecture) live in [README.md](README.md); UI rules live in [DESIGN.md](DESIGN.md). This file is the contributor task reference. `mise tasks` is authoritative; `mise run <task> --help` documents flags.

## Quick start

```bash
mise run setup   # .env, pnpm install, Playwright browser, Mullvad keypair (first time)
mise run up      # build + start the stack (app + worker, plus vpn sidecar when configured) → http://localhost:8080
```

## Tasks

| Command | Description |
|---|---|
| `mise run setup` | One-time setup: `.env`, pnpm deps, Playwright browser, Mullvad WireGuard keypair |
| `mise run up` | Build + start the stack (app + worker, plus vpn sidecar when configured) |
| `mise run build` | Build the container image only |
| `mise run status` | `podman-compose ps` |
| `mise run logs [service]` | Follow logs (default: `app worker`) |
| `mise run down` | Stop the stack (keeps volumes) |
| `mise run clean [--yes]` | Stop + delete all data (`down -v`) |
| `mise run restart [service]` | Restart a service (default: `worker`) |
| `mise run test` | Full hermetic gate: typecheck + unit (domain, fakes) + arch (archunit) + integration (adapter boundaries) + e2e (no tokens; live excluded) |
| `mise run coverage [-m PCT]` | Measure per-layer code coverage via node's built-in test runner; `-m`/`--min-lines PCT` fails if any layer's line coverage drops below PCT |
| `mise run test-live` | Live micro test that consumes real tokens (opt-in; needs the OpenRouter secret; `RUN_LIVE_TESTS=1`) |
| `mise run test-ui` | UI specs only (mocked API) |
| `mise run test-stack` | API + fake-worker specs only |
| `mise run test-containers` | Container smoke e2e: real image + fake worker via podman-compose (slow; needs podman) |
| `mise run mutation [--all\|--shared\|--worker] [--dry]` | Mutation testing via StrykerJS — `domain` scope by default (fast, hermetic); `--all` widens to `domain+shared+worker` (slow); `--dry` verifies without mutating; HTML report `test-results/mutation/` |
| `mise run pipeline <url>` | Submit a YouTube URL to the running stack, poll until done |
| `mise run app [-p PORT]` | Run the web app locally (no container) |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run mullvad <mode>` | Mullvad operations: relay rotation (`scan`), config provisioning (`init`), tunnel debug (`run`/`test`/`dryrun`/`status`) — the production path is the `vpn` sidecar, no `MULLVAD_ACCOUNT` needed for the interactive flow |
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

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `tl` (test-live), `tc` (test-containers), `test-ui`, `test-stack`, `cov` (coverage), `mut` (mutation).

## Notes for agents

- Tests: `mise run t` is the hermetic gate (`test:unit` → `tests/unit/**` domain use cases with fakes, `test:arch` → `tests/arch/**` via `archunit` layers, `test:integration` → `tests/integration/**` real adapter boundaries, `test:e2e` → `e2e/**` UI/stack). Token-consuming live tests live in `tests/live/**` and run only via `mise run test-live` (`RUN_LIVE_TESTS=1`, opt-in; skipped by the gate). Unit tests cover domain use cases through ports (fakes/mocks); integration tests exercise outbound adapters (real fs/process/stubbed HTTP); e2e Playwright specs use a mocked API or replay through the fake worker; `test-containers` is outside the gate. Artifacts go to `test-results/` (gitignored).
- Mutation: `mise run mutation` (alias `mut`) runs StrykerJS with the `command` runner (native `node --test`, Node 24 type-stripping) over unit+integration. Default scope mutates `src/domain/**` only (fast); `--all` widens to `src/domain/**,src/shared/**,src/worker/**`; `--shared`/`--worker` target one layer; `--dry` is dry-run. Reports go to `test-results/mutation/` (HTML + clear-text). Config is `stryker.config.mjs` (`inPlace:false`, sandbox temp dir `.stryker-tmp/`, gitignored). Thresholds `high 80 / low 60` are informational (`break: null`, non-blocking).
- Coverage: `mise run coverage` (alias `cov`) measures line/branch/function coverage per layer — `domain` (pure logic), `worker` (outbound stages + pipeline/bootstrap), `shared`, `vpn`, `app` — by running the hermetic unit+integration gate under `node --test --experimental-test-coverage` and parsing the `lcov` report (`scripts/coverage.ts` + pure LCOV parser `scripts/cov-parse.ts`). It re-runs the tests itself and exits non-zero if they fail; `-m`/`--min-lines PCT` additionally fails if any layer's line coverage drops below PCT. Parser unit tests live in `tests/unit/cov-parse.test.ts`. Deliberately uncovered: the thin `worker.ts` bootstrap (logic lives in testable `worker-core.ts`) and `app`/`vpn` (covered by Playwright e2e instead).
- The stack runs via podman-compose (services `app` + `worker`, plus the `vpn` sidecar when `~/.local/mullvad-poc/wg0.conf` exists); the OpenRouter key is host GPG-encrypted at rest (`~/.secrets/openrouter.gpg` + `~/.gnupg`, 0600/0700) and synced into the `openrouter_key` podman secret (at `/run/secrets/*`, tmpfs 0440) via `scripts/sync-secrets.sh` (`mise run up` does it automatically) so the non-root `node` worker can read it despite rootless UID mapping — never put keys in `.env`. A legacy bind mount (`/secrets/openrouter.gpg` + `/gnupg`) is still read as fallback for OpenRouter. `app`/`worker` run as `node` (USER node), only `vpn` stays root (needs NET_ADMIN + /dev/net/tun, confined to its netns).
- YouTube downloads go through Mullvad via the `vpn` sidecar service (compose): it brings up the WireGuard tunnel in its own netns and exposes a loopback-only SOCKS5 proxy (127.0.0.1:1080). The worker's yt-dlp uses `--proxy socks5h://…` (`MULLVAD_ENABLED`/`MULLVAD_PROXY` in `.env`) — only yt-dlp's traffic exits via the tunnel. No host routes/firewall are touched; the tunnel never leaves the sidecar's network namespace. The WireGuard config lives at `~/.local/mullvad-poc/wg0.conf` (private key, 0600). Re-scan relays when YouTube starts blocking again: `mise run mullvad scan` (then `mise run mullvad init -i <addr> -r <relay>`).
- Local dev data dirs: `.local/` (gitignored).
- Raw commands (`podman-compose …`, `pnpm run …`) work, but task files are the documented interface.
