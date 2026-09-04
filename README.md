# Summarize YT

Self-hosted YouTube-to-learning-note workstation. Paste one YouTube video URL, then the worker downloads the audio, converts it, transcribes it with the OpenRouter STT API, and summarizes the transcript with the OpenRouter chat API into a structured Markdown study note.

## Requirements

- [mise](https://mise.jdx.dev) — the DevEx entrypoint: pins the Node toolchain (`mise.toml`) and runs every project command below
- Podman 5+ and `podman-compose`
- Network access for the image build, YouTube, and OpenRouter (STT + chat)
- Host GPG secrets at these exact paths:
  - `~/.secrets/openrouter.gpg`
  - `~/.gnupg/`
- The OpenRouter account must have the **microsoft** and **meta** providers authorized (Settings → Provider Preferences), otherwise STT/summarization returns `404 No allowed providers are available`.

The API key is not stored in `.env`, the image, or a volume. The worker mounts the encrypted payload and keyring read-only, copies the keyring to a writable temporary GnuPG home, and decrypts the key in memory per request (`gpg --batch --decrypt`). There is no agent runtime in the pipeline: both paid stages are plain HTTPS calls to OpenRouter.

## Quick start

```bash
mise install     # one-time: installs the pinned Node version (node 24, same as the container)
mise run setup   # one-time: creates .env, runs pnpm install, installs the Playwright browser
mise run up      # builds and starts the stack (app + worker)
```

Open [http://localhost:8080](http://localhost:8080).

## All commands

mise is the single entrypoint for every contributor action. Task files live in
`.mise/tasks/`; each one documents its own usage (`mise run <task> --help`).
`mise tasks` lists everything.

| Command | What it does |
|---|---|
| `mise run setup` | One-time setup: `.env` from `.env.example`, pnpm deps, Playwright browser |
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
| `mise run backup` | Snapshot both volumes (SQLite job DB + artifacts) to `~/.local/backups/` (keeps the last 10; set `BACKUP_KEEP` to change) |
| `mise run restore <file> [--yes]` | Restore volumes from a backup archive (stops the stack, restores, restarts; prompts unless `--yes`) |
| `mise run app [-p PORT]` | Run the web app locally (no container) for UI/API iteration |
| `mise run worker` | Run the worker locally (no container; paid stages need the stack) |
| `mise run cookies <file>` | Install a Netscape `cookies.txt` for the worker and restart it |
| `mise run doctor` | Verify tools, Node version, `.env`, and GPG secrets |
| `mise run docs` | Serve the architecture docs (Mermaid diagrams) at http://localhost:8123; `--expose` also publishes them on the tailnet at `https://<machine>.ts.net:8443/` |

Aliases: `install` (setup), `start` (up), `stop` (down), `ps` (status), `b` (build), `t` (test), `check` (doctor).

Examples:

```bash
mise run pipeline "https://youtu.be/..."
mise run logs
mise run clean --yes        # reset the whole stack, no prompt
mise run app -p 9000        # local UI iteration on port 9000
```

The raw commands (`podman-compose …`, `pnpm run test:e2e`) remain available, but
the task files under `.mise/tasks/` are the documented interface.

## Config

Runtime settings live in `.env` (created by `mise run setup`; see `.env.example`).
To change the transcription or summarization models, set `STT_MODEL` / `LLM_MODEL`
there (defaults: `microsoft/mai-transcribe-2`,
`meta/muse-spark-1.3-contributor`).

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

This copies the file to `~/.secrets/youtube-cookies.txt` (mode 600), syncs it
into the `youtube_cookies` podman secret, and restarts the worker. The worker
automatically passes `--cookies /run/secrets/youtube_cookies` to yt-dlp when
the secret contains a valid Netscape cookies file.

## Mullvad VPN (downloads from a datacenter IP)

YouTube blocks datacenter IPs. To download reliably, the worker routes yt-dlp
through a Mullvad WireGuard tunnel via the `vpn` sidecar (a loopback-only SOCKS5
proxy on `127.0.0.1:1080`; nothing else — app, worker, host — is affected).

First-time setup (needs a Mullvad account, ~€5/month):

```bash
mise run mullvad init    # interactive: génère une paire de clés, affiche la
                             # clé PUBLIQUE à enregistrer sur mullvad.net, puis
                             # demande l'adresse de tunnel attribuée (10.x.x.x/32)
mise run up                  # démarre app + worker + vpn
```

Alternative automatisée (l'API attribue l'adresse toute seule) :
`MULLVAD_ACCOUNT=<16 chiffres> mise run mullvad init`.

- Clé privée + config WireGuard : `~/.local/mullvad-poc/` (mode 600 — ne jamais
  partager ; la clé publique seule va sur mullvad.net).
- YouTube blackliste les IP de sortie au fil du temps : `mise run mullvad scan`
  pour trouver un relais qui passe, puis `mise run mullvad init -i <addr> -r <relais>`.
- Sans config, le service `vpn` reste arrêté proprement et le stack démarre quand
  même ; pour télécharger en direct (IP du datacenter, souvent bloquée) :
  `MULLVAD_ENABLED=false` dans `.env`.
- Vérification : `mise run doctor` signale une config Mullvad manquante.

## Production access (Tailscale)

The app is served over HTTPS from the tailnet only — it is never published on a
public interface (`compose.yaml` binds `127.0.0.1:8080`; the host's public IP
exposes nothing). `tailscaled` terminates TLS for:

    https://<machine>.ts.net/

Reachable only by devices on your tailnet. Set up (one-time, on the host):

```bash
sudo tailscale set --operator=$USER
mise run up                       # starts the stack, loopback-bound
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Inspect or disable with `tailscale serve status` / `tailscale serve --https=443 off`.
The serve config persists across reboots, and the stack restarts via
`restart: unless-stopped`.

## Pipeline

`yt-dlp → ffmpeg → OpenRouter STT API → OpenRouter chat API → rendered Markdown`

The app and worker share only the SQLite job database and the artifacts volume. The app never executes pipeline tools or calls OpenRouter. Jobs are processed one at a time, and stale running jobs are returned to the queue after a worker restart.

## API

- `POST /api/summarize` with `{ "url": "https://youtu.be/...", "lang": "fr" }` — `lang` is an optional two-letter ISO 639-1 code for the note's language (default `en`; the UI pre-selects the browser locale). The same URL in a different language produces a new job.
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
