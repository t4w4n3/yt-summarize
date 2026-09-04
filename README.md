# Summarize YT

Self-hosted YouTube-to-learning-note workstation. Paste one YouTube video URL, then the worker downloads the audio, converts it, transcribes it with the OpenRouter STT API, and summarizes the transcript with the OpenRouter chat API into a structured Markdown study note.

## Documentation map

This documentation follows [Diataxis](https://diataxis.fr/):

- **Tutorial** — [Quick start](#quick-start): get from zero to your first note.
- **How-to guides** — [How-to guides](#how-to-guides): solve a specific problem (VPN, backup, local iteration).
- **Reference** — [Reference](#reference): commands, configuration, and API facts.
- **Explanation** — [How it works](#how-it-works): concepts that clarify why the system behaves the way it does.

Contributor task reference lives in [AGENTS.md](AGENTS.md); UI rules live in [DESIGN.md](DESIGN.md). The authoritative command list is `mise tasks`, and every task documents its own flags (`mise run <task> --help`).

## Requirements

- [mise](https://mise.jdx.dev) — the DevEx entrypoint: provisions the pinned Node toolchain (`mise.toml`) and runs every project command below
- Podman 5+ and `podman-compose`
- Network access for the image build, YouTube, and OpenRouter (STT + chat)
- Host GPG secrets at these exact paths:
  - `~/.secrets/openrouter.gpg`
  - `~/.gnupg/`
- The OpenRouter account must have the **microsoft** and **meta** providers authorized (Settings → Provider Preferences), otherwise STT/summarization returns `404 No allowed providers are available`.

The API key is never stored in `.env`, the image, or a volume. `mise run up` syncs the encrypted payload into podman secrets, and the worker decrypts the key in memory per request (`gpg --batch --decrypt`). There is no agent runtime in the pipeline: both paid stages are plain HTTPS calls to OpenRouter.

## Quick start

```bash
mise run setup   # one-time: creates .env, installs pnpm deps, installs the Playwright browser, generates the Mullvad WireGuard keypair
mise run up      # builds and starts the stack (app + worker, plus the vpn sidecar when configured)
```

Open [http://localhost:8080](http://localhost:8080), paste a YouTube video URL, and submit. The UI polls the job through four stages (downloading → converting → transcribing → summarizing) and renders the Markdown note when done.

The Node toolchain (currently Node 24.18.1) is provided automatically by every `mise run` task, matching the container's `node:24-bookworm-slim` image and `package.json` engines.

## How-to guides

### Summarize a video end to end

```bash
mise run pipeline "https://youtu.be/..."
```

Submits the URL to the running stack and polls until the note is ready. Accepts single video URLs only (`youtube.com` with `www.`/`m.`/`music.` subdomains, `youtu.be`); playlists are rejected (`--no-playlist`). The same video requested in another language produces a new job.

### Download reliably via the Mullvad VPN

YouTube blocks datacenter IPs. The worker can route yt-dlp through a Mullvad WireGuard tunnel via the `vpn` sidecar, which exposes a loopback-only SOCKS5 proxy on `127.0.0.1:1080`. Only yt-dlp's traffic exits through the tunnel — the app, the rest of the worker, and the host are unaffected, and no host routes or firewall rules are touched.

First-time setup (needs a Mullvad account, ~€5/month):

```bash
mise run mullvad init    # interactive: generates a keypair, prints the PUBLIC key
                         # to register on mullvad.net, then asks for the tunnel
                         # address that was assigned (10.x.x.x/32)
mise run up              # starts app + worker + vpn
```

Fully automated alternative (the API assigns the address itself):

```bash
MULLVAD_ACCOUNT=<16 digits> mise run mullvad init
```

Notes:

- Private key + WireGuard config live at `~/.local/mullvad-poc/` (mode 600 — never share; only the public key goes to mullvad.net).
- YouTube blacklists exit IPs over time: run `mise run mullvad scan` to find a relay that works, then `mise run mullvad init -i <addr> -r <relay>`.
- Without a config, the `vpn` service stays down cleanly and the stack still starts. To download directly (datacenter IP, often blocked), set `MULLVAD_ENABLED=false` in `.env`.
- `mise run doctor` reports a missing Mullvad config.

### Access the app remotely (optional)

The stack binds `127.0.0.1:8080` (loopback only — never exposed publicly). Open [http://localhost:8080](http://localhost:8080) on the host, or expose it with whatever reverse proxy / tunnel you already use.

### Back up and restore data

```bash
mise run backup            # snapshot both volumes (SQLite job DB + artifacts) to ~/.local/backups/ (keeps the last 10; set BACKUP_KEEP to change)
mise run restore <file> [--yes]   # stop the stack, restore, restart (prompts unless --yes)
```

### Iterate locally (no container)

```bash
mise run app -p 9000   # run the web app locally for UI/API iteration
mise run worker        # run the worker locally (paid stages need the stack secrets)
```

## Reference

### Commands

Everyday commands. Contributor commands (coverage, mutation, lint, security, full gate) are referenced in [AGENTS.md](AGENTS.md); `mise tasks` is authoritative.

| Command | What it does |
|---|---|
| `mise run setup` | One-time setup: `.env` from `.env.example`, pnpm deps, Playwright browser, Mullvad keypair |
| `mise run up` | Build + start the stack (`podman-compose up -d --build`) |
| `mise run build` | Build the container image only |
| `mise run status` | Show container status (`podman-compose ps`) |
| `mise run logs [service]` | Follow logs (default: `app worker`) |
| `mise run down` | Stop the stack (keeps the jobs DB and artifacts) |
| `mise run clean [--yes]` | Stop and delete all data (`down -v`); prompts unless `--yes` |
| `mise run restart [service]` | Restart a service (default: `worker`) |
| `mise run test` | Full hermetic gate: typecheck + unit + arch + integration + e2e (no tokens; live excluded) |
| `mise run test-ui` | UI specs only (mocked API) |
| `mise run test-stack` | API + fake-worker specs only |
| `mise run test-containers` | Container smoke e2e: real image + fake worker via podman-compose (slow; needs podman) |
| `mise run pipeline <url>` | Submit a YouTube URL to the running stack and poll until done |
| `mise run app [-p PORT]` | Run the web app locally (no container) for UI/API iteration |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run mullvad <mode>` | Mullvad operations: relay rotation (`scan`), config provisioning (`init`), tunnel debug (`run`/`test`/`dryrun`/`status`) |
| `mise run backup` | Snapshot both volumes (SQLite job DB + artifacts) to `~/.local/backups/` |
| `mise run restore <file> [--yes]` | Restore volumes from a backup archive (stops the stack, restores, restarts) |
| `mise run doctor` | Verify tools, Node version, `.env`, and GPG secrets |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `tl` (test-live), `tc` (test-containers).

Examples:

```bash
mise run pipeline "https://youtu.be/..."
mise run logs
mise run clean --yes        # reset the whole stack, no prompt
mise run app -p 9000        # local UI iteration on port 9000
```

The raw commands (`podman-compose …`, `pnpm run …`) remain available, but the task files under `.mise/tasks/` are the documented interface.

### Configuration

Runtime settings live in `.env` (created by `mise run setup`; see `.env.example`). Never put API keys there.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port the app listens on (loopback-bound via compose) |
| `DATA_DIR` | `/data` | SQLite job database directory (shared `jobs-data` volume) |
| `ARTIFACTS_DIR` | `/artifacts` | Stage artifacts directory (`artifacts` volume) |
| `STT_MODEL` | `microsoft/mai-transcribe-2` | Speech-to-text model (OpenRouter) |
| `LLM_PROVIDER` | `openrouter` | Chat provider for summarization |
| `LLM_MODEL` | `meta/muse-spark-1.3-contributor` | Summarization model (OpenRouter) |
| `LLM_THINKING` | `high` | Reasoning effort for the summarization model |
| `WORKER_POLL_MS` | `2000` | Worker polling interval between queue checks |
| `JOB_TIMEOUT_MS` | `1800000` | Whole-job timeout (30 min) before the job fails |
| `STALE_AFTER_MS` | `600000` | Heartbeat silence (10 min) after which a running job is re-queued |
| `MULLVAD_ENABLED` | `true` | Route yt-dlp through the `vpn` sidecar SOCKS5 proxy |
| `MULLVAD_PROXY` | `socks5h://127.0.0.1:1080` | SOCKS5 proxy URL used by yt-dlp when Mullvad is enabled |

### API

- `POST /api/summarize` with `{ "url": "https://youtu.be/...", "lang": "fr" }` — `lang` is an optional two-letter ISO 639-1 code for the note's language (default `en`; the UI pre-selects the browser locale). Responses: `201 { jobId }` for a new job, `200 { jobId, deduped: true }` when the same video + language already has a job, `400 { error }` for an invalid URL or language.
- `GET /api/jobs/:id` — `200 { jobId, status, stage, progress, title, error, createdAt, updatedAt }`, `404 { error }` when unknown. `status` is `queued`, `running`, `done`, or `failed`; `stage` is one of `downloading`, `converting`, `transcribing`, `summarizing`.
- `GET /api/jobs/:id/result` — `200 { title, markdown, wordCount }` when done, `404 { error }` when unknown, `409 { error }` while the note is not ready yet.
- `GET /api/jobs/:id/result.md` — the note as a Markdown file attachment (filename derived from the title), `404` when unknown, `409` while not ready yet.

## How it works

### Services and pipeline

One container image runs as three compose services sharing two named volumes:

- **app** — Express server on `:8080` (loopback-only): REST API + static single-page UI. Never executes pipeline tools, never calls OpenRouter.
- **worker** — poll loop (`WORKER_POLL_MS`): claims the next queued job, sends heartbeats, runs the four stages one job at a time with per-stage timeouts (downloading 10 min, converting 15 min, transcribing 25 min, summarizing 10 min), then marks the job done or failed with a per-stage error. Temporary files are cleaned after each job; the transcript and the summary are kept.
- **vpn** — WireGuard tunnel in its own network namespace plus a loopback-only SOCKS5 proxy (`127.0.0.1:1080`). Only yt-dlp's traffic exits through it; DNS is resolved inside the tunnel.

Pipeline per job:

`yt-dlp (bestaudio, --no-playlist) → ffmpeg (16 kHz mono PCM WAV) → OpenRouter STT API → OpenRouter chat API (study-note prompt) → rendered Markdown`

The app and worker share only the SQLite job database and the artifacts volume. Stale running jobs (no heartbeat for `STALE_AFTER_MS`, e.g. after a worker restart) return to the queue; jobs exceeding `JOB_TIMEOUT_MS` fail.

### Study note structure

The summarization prompt produces a study artifact proportional to the video length: TL;DR, key learnings (claim + rationale, never rationale-free), concepts & terms, details, opinions vs. established facts, action items / next steps, and mentioned resources. Sections with no content are omitted rather than invented; obvious transcription mis-hearings are silently corrected; the speaker's terminology and numbers are preserved. Out of scope for v1: playlists/channels, queue/history UI, accounts, rate limiting, cost tracking, offline transcription.

### Secrets and trust boundaries

- The OpenRouter key is GPG-encrypted at rest on the host (`~/.secrets/openrouter.gpg`, 0600) with a passphrase-less keyring (`~/.gnupg`, 0700). `mise run up` syncs it into the `openrouter_key` podman secret; the worker reads `/run/secrets/openrouter_key` (tmpfs, 0440) and decrypts per request, so the plaintext key only ever lives in worker memory for one HTTPS call. It never lands in `.env`, the image, or a volume.
- `app`/`worker` run as non-root `node`; only `vpn` runs as root (needs `NET_ADMIN` + `/dev/net/tun`, confined to its own network namespace).

## Testing

The suite runs without YouTube access, OpenRouter credits, or API keys:

```bash
mise run setup   # first time only
mise run test    # typecheck + unit + arch + integration + e2e
```

The hermetic gate covers domain use cases through ports (fakes), outbound adapter boundaries (real fs/process/stubbed HTTP), architecture layers, and Playwright UI + stack specs (mocked API; fake worker against the real SQLite job store, exercising queue, polling, result, and Markdown download). Token-consuming live tests are opt-in only (`mise run test-live`, needs the OpenRouter secret). Test artifacts go to `test-results/` (gitignored).

### Container smoke tests (optional, slower)

The host-process suite never exercises the image itself — the Dockerfile, entrypoints, and compose wiring ship untested. `mise run test-containers` closes that gap: it builds the real image and runs the stack specs against it via a dedicated compose file (`e2e/compose.e2e.yaml`), which swaps the real worker for the fake one (no secrets, no yt-dlp/ffmpeg/gnupg) and maps ports 4174/4175 so it can run alongside a dev stack:

```bash
mise run test-containers   # needs podman/podman-compose; builds the image on first run
```

The stack is brought up with `podman-compose up -d --build`, waited on for health, and torn down with `down -v` — including on failure. Job data lives in `e2e/.tmp/data` (gitignored) for inspection.
