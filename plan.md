# plan.md — YouTube Audio → Markdown Learning Summary Web App

## 1. Goal

A self-hosted web app, fully containerized with **podman compose**, that:

1. Accepts a YouTube URL from a user.
2. Downloads the audio track with **yt-dlp**.
3. Converts it to a transcription-friendly format with **ffmpeg**.
4. Transcribes the audio to text with the **OpenRouter STT API** (`mistralai/voxtral-mini-transcribe`).
5. Summarizes the transcript with the **OpenRouter chat completions API** (`deepseek/deepseek-v4-flash-0731`) into a rich Markdown document covering "all things to learn" from the video.
6. Returns the Markdown to the user in the browser (rendered + downloadable as `.md`).

---

## 2. Design decisions (read first)

**Speech-to-text is mandatory.** The original ask was *yt-dlp → ffmpeg → summarize*. The summarization model is text-in/text-out, so a speech-to-text step is required between ffmpeg and the summarizer.

**No agent runtime in the pipeline.** Both paid stages are plain HTTPS calls to OpenRouter (audio transcription + chat completions). A coding-agent CLI (e.g. Pi) adds nothing over calling the API directly: same provider, same GPG-protected key, one text-in/text-out call. This keeps the image small and removes model-catalog, session, and CLI-flag dependencies. The host's Pi installation remains only as the user's own key management tool; the container never uses it.

**Pipeline (final):**

```
YouTube URL
   │
   ▼
yt-dlp  ──► best audio stream (m4a/opus/webm)
   │
   ▼
ffmpeg  ──► 16 kHz mono WAV (compact, standard upload format)
   │
   ▼
OpenRouter STT API  ──► transcript.txt   (mistralai/voxtral-mini-transcribe)
   │
   ▼
OpenRouter chat API  ──► summary.md      (deepseek/deepseek-v4-flash-0731, thinking high)
   │
   ▼
Web UI renders Markdown + offers .md download
```

Chosen stack: **Node.js** throughout (web API + worker) — one runtime, one image. SQLite (via Node's built-in `node:sqlite`, stable in Node ≥ 24) for job state, no native deps, and no compiled speech tools.

---

## 3. Architecture

Two services in one podman compose project, sharing volumes:

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  app (web)              │        │  worker (pipeline)       │
│  ┌───────────────────┐  │  HTTP  │  ┌────────────────────┐  │
│  │ static UI (HTML/JS)│  │        │  │ job loop (polls DB)│  │
│  │ Express API        │◄─┼────────┼──│ pipeline.js        │  │
│  │ SQLite job store   │  │        │  │  yt-dlp            │  │
│  └───────────────────┘  │        │  │  ffmpeg            │  │
└─────────────────────────┘        │  │  OpenRouter STT    │  │
                                   │  │  OpenRouter chat   │  │
                                   │  └────────────────────┘  │
        volumes:  jobs.db (shared), artifacts/ (audio+wav+txt+md)
```

- **`app`** — Express server. Serves the UI, creates jobs, serves status + results. Never touches yt-dlp/ffmpeg and never calls OpenRouter.
- **`worker`** — single-process job loop, **concurrency = 1** by default (YouTube rate limits + model API cost). Polls the SQLite `jobs` table for `pending` jobs, runs the 4-stage pipeline, writes status/progress/errors back to the DB and artifacts to a shared volume.
- Shared SQLite DB file lives on a named volume so both services see the same state (SQLite with WAL handles one writer + one reader fine here).
- Both services are the **same image** (single-stage `Dockerfile`) started with different commands. The worker uses **host networking** because this host lacks podman's `aardvark-dns`, which breaks container DNS; host mode also avoids NAT surprises with YouTube.

### Directory layout

```
summarize-yt/
├── compose.yaml
├── .env.example                 # model, limits (NO API keys — key is GPG-encrypted at rest, see §4.4)
├── README.md
├── .dockerignore
├── image/
│   ├── Dockerfile               # single-stage: tools + runtime
│   ├── entrypoint-app.sh        # runs node server.js
│   └── entrypoint-worker.sh     # runs node worker.js
├── src/
│   ├── shared/
│   │   ├── db.js                # node:sqlite job store (open, create, claim, update)
│   │   └── constants.js         # job states, stage names, env defaults
│   ├── app/
│   │   ├── server.js            # Express: /api/* routes, static hosting
│   │   └── public/
│   │       ├── index.html
│   │       ├── app.js           # fetch + poll + render markdown (marked + DOMPurify)
│   │       └── style.css
│   └── worker/
│       ├── worker.js            # loop: claim job → pipeline → update job
│       ├── pipeline.js          # orchestrates 4 stages, per-stage timeout
│       ├── stages/
│       │   ├── download.js      # spawn yt-dlp (optional cookies)
│       │   ├── convert.js       # spawn ffmpeg
│       │   ├── transcribe.js    # OpenRouter STT API call
│       │   ├── summarize.js     # OpenRouter chat completions call
│       │   └── openrouter.js    # shared in-memory GPG key resolution
│       └── prompts.js           # summarizer system prompt
└── scripts/
    └── test-pipeline.sh         # local end-to-end smoke test on a known video
```

---

## 4. Services in detail

### 4.1 `app` — Express API + static UI

Routes:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Static UI (`index.html`) |
| POST | `/api/summarize` | Body `{ "url": "..." }` → validates URL, creates job, returns `{ jobId }` |
| GET | `/api/jobs/:id` | Returns `{ status, stage, progress, error?, createdAt, ... }` |
| GET | `/api/jobs/:id/result` | `{ title?, markdown }` once `done` |
| GET | `/api/jobs/:id/result.md` | `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment` |

Validation rules (`src/shared/constants.js`):
- Must parse as URL with host `youtube.com` (incl. `www.`), `m.youtube.com`, `music.youtube.com`, or `youtu.be`.
- Reject non-`http(s)` schemes, usernames/passwords, non-standard ports, and any other host.
- Simple regex sanity check for video id (`[A-Za-z0-9_-]{11}` for watch URLs, short code for youtu.be); yt-dlp remains the final authority and its error is surfaced to the user.

### 4.2 `worker` — pipeline

`worker.js` loop (pseudo):

```
while true:
  row = db.claimNextPendingJob()        # UPDATE ... SET status='running', claimed_at=now
  if no row: sleep 2s; continue
  try:
    info = await runStage(download)     # also fetch title via yt-dlp --print
    await runStage(convert)
    await runStage(transcribe)
    markdown = await runStage(summarize)
    db.markDone(jobId, title, markdown)
  catch e:
    db.markFailed(jobId, friendlyMessage(e), stage)
  finally:
    cleanup(jobId)                       # delete .m4a/.wav, keep transcript.txt + summary.md
```

Each stage: spawn process with `maxBuffer` guard or a bounded `fetch`, `timeoutMs` (see §7), log to `artifacts/<jobId>/stage.log`, and emit heartbeat `last_heartbeat_at` so stale `running` jobs can be re-queued after crash/restart.

#### Stage 1 — Download (yt-dlp)

```bash
yt-dlp --no-playlist --no-update \
  --print "%(title)s" \
  -f "bestaudio/best" \
  -o "/artifacts/<jobId>/audio.%(ext)s" \
  "<url>"
```

- `--no-playlist` — we summarize one video only.
- `--print` captures the title to stdout for the result page.
- Prefer bestaudio (typically m4a/opus/webm) — small, fast; full quality unnecessary since transcription is 16 kHz.
- **Cookies:** YouTube bot-checks datacenter/VPN IPs. When `~/.secrets/youtube-cookies.txt` exists (mounted at `/secrets/youtube-cookies.txt`, Netscape format, exported from a logged-in browser), the stage adds `--cookies` automatically. Without it, downloads may fail with "Sign in to confirm you're not a bot" on hosted IPs.

#### Stage 2 — Convert (ffmpeg)

```bash
ffmpeg -y -i audio.<ext> \
  -ar 16000 -ac 1 -c:a pcm_s16le \
  /artifacts/<jobId>/audio.wav
```

16 kHz mono 16-bit PCM is a compact, universally accepted upload format for the STT API (≈1.9 MB/min; a 30-min job uploads ~58 MB).

#### Stage 3 — Transcribe (OpenRouter STT API)

```bash
KEY=$(gpg --quiet --batch --no-tty --decrypt /secrets/openrouter.gpg)   # in-memory, see §4.4
curl -sS https://openrouter.ai/api/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F "model=mistralai/voxtral-mini-transcribe" \
  -F "file=@/artifacts/<jobId>/audio.wav"
```

The response is `{ "text": "..." }`; the worker extracts `text` into `transcript.txt` (plain text, no timestamps — timestamps add tokens for no summarization value).

Notes:
- Implemented as a multipart `fetch` with an `AbortController` timeout (25 min default).
- **Provider authorization:** the OpenRouter account must allow the model's provider (Settings → Provider Preferences → allow `mistral`). Otherwise the API returns `404 No allowed providers are available for the selected model`, even with a valid key.
- On failure the job surfaces the HTTP status and the API's error body (e.g. 401 key, 402 balance, 429 rate limit, 400 unsupported format).
- `audio.wav` is deleted after transcription; `transcript.txt` is kept for the summarize stage and retries.

#### Stage 4 — Summarize (OpenRouter chat completions)

```bash
KEY=$(gpg --quiet --batch --no-tty --decrypt /secrets/openrouter.gpg)
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{
    \"model\": \"deepseek/deepseek-v4-flash-0731\",
    \"messages\": [
      { \"role\": \"system\", \"content\": \"$(cat /app/prompts/summarize.md)\" },
      { \"role\": \"user\", \"content\": \"Summarize this video transcript into the requested Markdown structure.\n\n$(cat /artifacts/<jobId>/transcript.txt)\" }
    ],
    \"reasoning\": { \"effort\": \"high\" }
  }"
```

Rationale:
- One text-in/text-out call: system prompt (the study-note structure) + transcript in, Markdown out. No agent runtime, no catalog, no sessions.
- **`reasoning: { effort: high }`** — DeepSeek V4 Flash supports only `high`/`xhigh` thinking levels; do not pass `low`/`medium`.
- `deepseek/deepseek-v4-flash-0731` has a 1M context window / 384k max output, so long transcripts are fine; cost is ~$0.14 in / $0.28 out per 1M tokens.
- We take `choices[0].message.content`, strip a wrapping ```` ```markdown ```` fence if the model adds one, and write `summary.md`.
- Timeout 10 min (long transcripts).

### 4.3 Prompts (`src/worker/prompts/summarize.md`)

System prompt, the heart of "all things to learn":

```
You are an expert educator and note-taker. Given a video transcript,
produce a comprehensive Markdown summary of everything worth learning.
Output ONLY Markdown — no preamble, no code fences around the document.

Structure:
## Overview            — 2–4 sentences: what the video is about, its thesis
## Key Takeaways       — bullet list of the 5–10 most important ideas
## Core Concepts       — every distinct concept/term with a plain-language definition
## Steps & Techniques  — numbered actionable steps or methods demonstrated
## Examples & Evidence — concrete examples, data points, results cited
## Action Items        — what the viewer should do/apply after watching
## Glossary            — term → one-line definition
## Mentioned Resources — books, papers, tools, channels, links named in the video

Rules:
- Cover ALL distinct ideas; do not skip secondary topics.
- Use the speaker's own terminology, but define jargon on first use.
- Preserve numbers, names, and URLs exactly as spoken where discernible.
- If a section has no content, omit it rather than inventing content.
- Keep the whole summary proportional to the video (roughly 1 line per 30–60s
  of video, minimum 30 lines for a typical video).
```

User message: just "Summarize this video transcript." plus the transcript.

---

### 4.4 API key security — GPG at rest (OpenRouter)

#### Host state (from `~/PI_SETUP_REPORT.md`, summarized)

- Encrypted payload: `~/.secrets/openrouter.gpg` (`0600`, dir `0700`) — the `sk-or-v1-…` key, encrypted to a GPG keypair.
- GPG keypair: `~/.gnupg/` (`0700`), UID `Pi Agent (pi keyring) <pi@local>`, ed25519/cv25519, **passphrase-less by design** so headless `gpg --batch --decrypt` works with no pinentry.

#### In-container reproduction (worker)

The container never stores the plaintext key. `compose.yaml` mounts the two host artifacts **read-only** (`:ro`): `~/.secrets:/secrets:ro` and `~/.gnupg:/gnupg:ro`. The worker entrypoint:

1. Copies the keyring to a writable, container-local `$GNUPGHOME` (e.g. `/run/gnupg`, `chmod 700`) — so gpg never writes back to the host's `~/.gnupg` on a read-only mount.
2. Runs the worker.

Both paid stages (STT, chat) decrypt the key into worker memory per request with `gpg --quiet --batch --no-tty --decrypt /secrets/openrouter.gpg`. The plaintext lives only for the duration of a request and is never written to the image, `.env`, compose file, or volumes.

#### Threat model (carried over from report §6)

| Risk | Status |
|---|---|
| Backups / exfiltration of `openrouter.gpg` | Encrypted; useless without private key |
| Key at rest in the stack | None — only the `.gpg` ciphertext exists on disk |
| Same-user compromise of the worker container | **High residual** — a compromised container can read the mounted (read-only) keyring + payload and decrypt. This is the report's documented trade-off of a passphrase-less key. |
| Optional hardening | Generate a container-dedicated GPG keypair, re-encrypt a copy of the key for the container, mount only that encrypted copy + its keyring. |

## 5. Podman compose

`compose.yaml`:

```yaml
name: summarize-yt

services:
  app:
    build:
      context: .
      dockerfile: image/Dockerfile
    command: ["/app/entrypoint-app.sh"]
    ports:
      - "${PORT:-8080}:8080"
    environment:
      PORT: "8080"
      DATA_DIR: "/data"
    volumes:
      - jobs-data:/data
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: image/Dockerfile
    command: ["/app/entrypoint-worker.sh"]
    environment:
      DATA_DIR: "/data"
      ARTIFACTS_DIR: "/artifacts"
      STT_MODEL: "${STT_MODEL:-mistralai/voxtral-mini-transcribe}"
      LLM_PROVIDER: "${LLM_PROVIDER:-openrouter}"
      LLM_MODEL: "deepseek/deepseek-v4-flash-0731"
      LLM_THINKING: "${LLM_THINKING:-high}"
      WORKER_POLL_MS: "${WORKER_POLL_MS:-2000}"
      JOB_TIMEOUT_MS: "${JOB_TIMEOUT_MS:-1800000}"
      STALE_AFTER_MS: "${STALE_AFTER_MS:-600000}"
    volumes:
      - jobs-data:/data
      - artifacts:/artifacts
      - ${HOME}/.secrets:/secrets:ro           # OpenRouter key, GPG-encrypted at rest (never decrypted on disk)
      - ${HOME}/.gnupg:/gnupg:ro               # passphrase-less GPG keyring (read-only; copied to writable $GNUPGHOME by entrypoint)
    network_mode: host                         # host DNS/network; required on hosts without podman's aardvark-dns
    restart: unless-stopped

volumes:
  jobs-data:
  artifacts:
```

Notes:
- `podman compose up -d --build` — works with `podman-compose` or the Docker-Compat layer; both fine.
- **No API key in `.env`, compose, or image.** If the `~/.secrets` / `~/.gnupg` mounts are missing or perms are wrong, both paid stages fail with a clear "cannot resolve credential" error and the job is marked failed.
- `~/.gnupg` is mounted `:ro`; the entrypoint copies it to a writable `$GNUPGHOME` so gpg never writes to the host keyring.
- Rootless podman is fine; volumes are named (no SELinux `:Z` pain). If bind-mounts are ever used, add `:Z`.
- **`network_mode: host`** for the worker: this host lacks podman's `aardvark-dns`, which left the bridge network unable to resolve or egress; host mode uses the machine's DNS and network directly. The worker publishes no ports, so host mode costs nothing here.

---

## 6. Image (`image/Dockerfile`)

Single stage — there are no local speech tools, no agent runtime, and no model volumes:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg gnupg python3 pipx bash \
    && rm -rf /var/lib/apt/lists/*

RUN pipx install --pip-args="--no-cache-dir" "yt-dlp==2025.*"
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ /app/src/
COPY image/entrypoint-app.sh image/entrypoint-worker.sh /app/
RUN chmod +x /app/entrypoint-*.sh

EXPOSE 8080
```

Runtime image contents: node, ffmpeg, yt-dlp, gpg, curl. No build stage, no ~10-minute C++ compile, no model volume, no agent install.

Entrypoints:
- `entrypoint-app.sh` — `mkdir -p "$DATA_DIR"`, run `node src/app/server.js`.
- `entrypoint-worker.sh` — `mkdir -p "$DATA_DIR" "$ARTIFACTS_DIR"`, copy `/gnupg` → writable `$GNUPGHOME` (chmod 700), then run `node src/worker/worker.js`.

---

## 7. Robustness & operational concerns

| Concern | Mitigation |
|---|---|
| YouTube URL invalid / video private / region-blocked / age-restricted / bot-checked | Per-stage error mapping in `pipeline.js`; yt-dlp exit codes + stderr mapped to friendly messages stored on the job. On datacenter IPs, add a cookies file (`~/.secrets/youtube-cookies.txt`, §4.2 Stage 1). |
| YouTube rate limiting | Concurrency 1; `--sleep-requests 1` if needed; respect 429s. |
| Very long videos | `JOB_TIMEOUT_MS` default 30 min; per-stage timeouts (download 10 min, convert 15 min, STT 25 min, chat 10 min). |
| STT/chat API down / 429 / insufficient balance / invalid key | Stages fail with the HTTP status and API error body surfaced on the job; jobs are retriable. Models are configurable (`STT_MODEL`, `LLM_MODEL`). |
| STT model has no authorized provider | OpenRouter account must allow the model's provider (Settings → Provider Preferences); else 404 "No allowed providers are available". Documented in README. |
| Long audio / upload size | 16 kHz mono WAV keeps uploads ~1.9 MB/min; 25-min stage timeout; `audio.wav` deleted after transcription. |
| GPG mounts missing / keyring perms wrong | Both paid stages fail fast with "cannot resolve credential"; verify `~/.secrets` and `~/.gnupg` exist on host (`~/PI_SETUP_REPORT.md` §4) |
| OpenRouter down / 429 / insufficient balance | Paid stages fail with clear messages; jobs retriable; API error body surfaced in job error |
| Stuck jobs after worker restart | `claimed_at` + heartbeat; worker re-claims jobs `running` with stale heartbeat (>10 min). |
| Disk fill | Delete `audio.*` and `audio.wav` after transcription; cap artifacts per job (~50 MB); optional `ARTIFACTS_RETENTION_DAYS` cleanup job. |
| Markdown XSS in UI | Render with `marked` + `DOMPurify` (allowlist), never `innerHTML` of raw output; also offer plain `.md` download. |
| Secrets | OpenRouter key encrypted at rest (`~/.secrets/openrouter.gpg`, host, `0600`); decrypted in worker memory per request; nothing in `.env`/image/compose; `.env` gitignored |
| Local testing without podman | `scripts/test-pipeline.sh` runs the same commands on the host. |

---

## 8. API contract (concrete)

`POST /api/summarize` → `201 {"jobId":"<uuid>"}` or `400 {"error":"..."}`

`GET /api/jobs/:id`:
```json
{
  "jobId": "…",
  "status": "queued | running | done | failed",
  "stage": "downloading | converting | transcribing | summarizing | null",
  "title": "… | null",
  "error": "friendly message | null",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

`GET /api/jobs/:id/result`:
```json
{ "title": "…", "markdown": "…", "wordCount": 1234 }
```

UI flow: submit URL → `setInterval` poll `GET /api/jobs/:id` every 2 s → show stage badge (Downloading → Converting → Transcribing → Summarizing) → on `done`, render Markdown + "Download .md" button → on `failed`, show friendly error + "Try again".

---

## 9. Implementation phases

1. **Spike (host)** — verified with a real sample: `yt-dlp` URL handling, `ffmpeg` → 16 kHz mono WAV, `gpg --batch --decrypt` key resolution, `POST /api/v1/audio/transcriptions` (voxtral) returning `{ "text": ... }`, and `POST /api/v1/chat/completions` (deepseek, `reasoning.effort=high`) returning Markdown. Working commands + model choices are recorded above.
2. **Worker pipeline** — `pipeline.js` + `stages/*` as plain Node modules: download/convert spawn processes; transcribe/summarize are bounded `fetch` calls. SQLite schema: `jobs(id, url, status, stage, title, error, markdown, created_at, claimed_at, heartbeat, updated_at)`.
3. **API + UI** — Express routes + `index.html`/`app.js`; manual test with curl for the full lifecycle.
4. **Containerization** — `image/Dockerfile`, entrypoints, `compose.yaml`, `.env.example`.
5. **Hardening** — timeouts, error mapping, stale-job reclaim, cleanup, XSS sanitize, retention.
6. **README + acceptance test** — `README.md` (setup: `podman compose up -d --build`), `scripts/test-pipeline.sh`, and a documented known-good test video.

## 10. Out of scope (v1) / future work

- Playlists/channels (explicitly `--no-playlist` for now).
- Subtitle (`auto-sub`) fast path as a cheaper alternative to STT (could be a config toggle later).
- Local whisper.cpp transcription as an offline fallback (would reintroduce a build stage + model volume).
- Multi-job queue UI, history list, per-user rate limiting.
- Cost tracking (model token usage per job).
- Streaming progress from yt-dlp/STT (currently stage-level only).
