# Summarize YT

Self-hosted YouTube-to-learning-note workstation. Paste one YouTube video URL, then the worker downloads the audio, converts it, transcribes it with the OpenRouter STT API, and summarizes the transcript with the OpenRouter chat API into a structured Markdown study note.

## Requirements

- [mise](https://mise.jdx.dev) — the DevEx entrypoint: pins the Node toolchain (`mise.toml`) and runs every project command below
- Podman 5+ and `podman-compose`
- Network access for the image build, YouTube, and OpenRouter (STT + chat)
- Host Pi credentials following the GPG layout in `plan.md`:
  - `~/.secrets/openrouter.gpg`
  - `~/.gnupg/`
- The OpenRouter account must have the **mistral** provider authorized (Settings → Provider Preferences), otherwise STT returns `404 No allowed providers are available`.

The API key is not stored in `.env`, the image, or a volume. The worker mounts the encrypted payload and keyring read-only, copies the keyring to a writable temporary GnuPG home, and decrypts the key in memory per request (`gpg --batch --decrypt`). There is no agent runtime in the pipeline: both paid stages are plain HTTPS calls to OpenRouter.

## Quick start

```bash
mise install     # one-time: installs the pinned Node version (node 24, same as the container)
mise run setup   # one-time: creates .env, runs npm ci, installs the Playwright browser
mise run up      # builds and starts the stack (app + worker)
```

Open [http://localhost:8080](http://localhost:8080).

## All commands

mise is the single entrypoint for every contributor action. Task files live in
`.mise/tasks/`; each one documents its own usage (`mise run <task> --help`).
`mise tasks` lists everything.

| Command | What it does |
|---|---|
| `mise run setup` | One-time setup: `.env` from `.env.example`, npm deps, Playwright browser |
| `mise run up` | Build + start the stack (`podman-compose up -d --build`) |
| `mise run build` | Build the container image only |
| `mise run status` | Show container status (`podman-compose ps`) |
| `mise run logs [service]` | Follow logs (default: `app worker`) |
| `mise run down` | Stop the stack (keeps the jobs DB and artifacts) |
| `mise run clean` | Stop and delete all data (`down -v`); requires confirmation unless `--yes` |
| `mise run restart [service]` | Restart a service (default: `worker`) |
| `mise run test` | Full hermetic e2e suite (UI + stack; no YouTube/API keys) |
| `mise run test-ui` | UI specs only (mocked API) |
| `mise run test-stack` | API + fake-worker specs only |
| `mise run pipeline <url>` | Submit a YouTube URL to the running stack and poll until done |
| `mise run app [-p PORT]` | Run the web app locally (no container) for UI/API iteration |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run cookies <file>` | Install a Netscape `cookies.txt` for the worker and restart it |
| `mise run doctor` | Verify tools, Node version, `.env`, and GPG secrets |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `check` (doctor).

Examples:

```bash
mise run pipeline "https://youtu.be/..."
mise run logs
mise run clean --yes        # reset the whole stack, no prompt
mise run app -p 9000        # local UI iteration on port 9000
```

The raw commands (`podman-compose …`, `npm run test:e2e`) remain available, but
the task files under `.mise/tasks/` are the documented interface.

## Config

Runtime settings live in `.env` (created by `mise run setup`; see `.env.example`).
To change the transcription or summarization models, set `STT_MODEL` / `LLM_MODEL`
there (defaults: `mistralai/voxtral-mini-transcribe`,
`deepseek/deepseek-v4-flash-0731`).

The Node toolchain is pinned in `mise.toml` (`node = "24"`, matching the
container's `node:24-bookworm-slim` and `package.json` engines) and is provided
to every `mise run` task automatically.

## YouTube access

YouTube bot-checks datacenter and VPN IPs, which makes anonymous downloads fail with
"Sign in to confirm you're not a bot". If that happens, export a cookies file from a
browser where you're signed in to YouTube (Netscape format, e.g. with the
"Get cookies.txt LOCALLY" extension) and install it with:

```bash
mise run cookies ~/Downloads/youtube-cookies.txt
```

This copies the file to `~/.secrets/youtube-cookies.txt` (mode 600) and restarts
the worker. The worker automatically passes `--cookies /secrets/youtube-cookies.txt`
to yt-dlp when the file is present (it is mounted read-only from `~/.secrets`).

## Pipeline

`yt-dlp → ffmpeg → OpenRouter STT API → OpenRouter chat API → rendered Markdown`

The app and worker share only the SQLite job database and the artifacts volume. The app never executes pipeline tools or calls OpenRouter. Jobs are processed one at a time, and stale running jobs are returned to the queue after a worker restart.

## API

- `POST /api/summarize` with `{ "url": "https://youtu.be/..." }`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/result`
- `GET /api/jobs/:id/result.md`

## End-to-end tests

The Playwright suite runs without YouTube access, OpenRouter credits, or API keys:

```bash
mise run setup   # first time only
mise run test
```

The suite includes:

- hermetic UI tests with mocked API responses for validation, loading, all four pipeline stages, errors, sample notes, downloads, keyboard shortcuts, and mobile layout;
- real HTTP/API contract tests against the app server;
- a fake worker using the real SQLite job store, so the browser test exercises the actual queue, polling, result, and Markdown download flow.

Run only one group with `mise run test-ui` or `mise run test-stack`. Test artifacts are written to `test-results/` and are gitignored.

### Container smoke tests (optional, slower)

The host-process suite never exercises the Docker image itself — the Dockerfile, entrypoints, and compose wiring ship untested. `mise run test-containers` closes that gap: it builds the real image and runs the stack specs against it via a dedicated compose file (`e2e/compose.e2e.yaml`), which swaps the real worker for the fake one (no secrets, no yt-dlp/ffmpeg/gnupg) and maps ports 4174/4175 so it can run alongside a dev stack:

```bash
mise run test-containers   # needs podman/podman-compose; builds the image on first run
```

The stack is brought up with `podman-compose up -d --build`, waited on for health, and torn down with `down -v` — including on failure. Job data lives in `e2e/.tmp/data` (gitignored) for inspection.
