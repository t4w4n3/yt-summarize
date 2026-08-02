# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- Backend: Node 24 + Express + SQLite (`node:sqlite`), one container image run as two services (`app` + `worker`) under podman compose. Decided in `plan.md`.
- Frontend: single-page vanilla HTML/CSS/JS (Markdown rendered with `marked` + `DOMPurify`). The user is open to Vite/React, but explicitly prefers the simplest path for a minimal v1; the static single-page approach from `plan.md` stands unless a concrete need appears.
- Toolchain per job: yt-dlp → ffmpeg → OpenRouter STT API (`mistralai/voxtral-mini-transcribe`) → OpenRouter chat API (DeepSeek V4 Flash). Both paid stages are plain HTTPS calls; no agent runtime in the container. Fixed in `plan.md`.

## Users

The operator and owner of the tool (self-hosted, personal use on their own machine/network). The job being done: turn a watched or saved YouTube video into a **permanent study note** they will keep and return to — not a disposable blurb. The reader of the note is the same person, later.

## Product Purpose

Turn a YouTube video into a comprehensive Markdown learning summary covering "all things to learn" from the video, rendered in the browser and downloadable as `.md` so the note is durable and portable. Success means the note is complete enough to study from without re-watching the video.

## Positioning

The output is a study artifact, not a summary snippet: a structured document (Overview, Key Takeaways, Core Concepts, Steps & Techniques, Examples & Evidence, Action Items, Glossary, Mentioned Resources) that is proportional to video length, preserves the speaker's terminology and numbers, defines jargon, and omits empty sections rather than inventing content. A neighbor tool could not truthfully copy this without the same transcription-plus-LLM pipeline and prompt discipline.

## Operating Context

- Self-hosted with `podman compose up -d --build`; one web container and one worker container sharing a SQLite job store and an artifacts volume.
- Usage flow: paste a YouTube URL → submit → job polls through four stages (downloading → converting → transcribing → summarizing) → rendered Markdown + download button. One job at a time; concurrency 1 by design (YouTube rate limits, model cost).
- A job can take minutes (long videos up to ~30 min budget); the user watches stage progress and returns when it completes.
- The OpenRouter API key lives GPG-encrypted on the host, mounted read-only into the container, decrypted in worker memory only. Never in `.env`, image, or volumes.

## Capabilities and Constraints

- Accepts single YouTube video URLs only (`youtube.com`, `www.`/`m.`/`music.` variants, `youtu.be`); no playlists/channels (explicit `--no-playlist`).
- Four-stage pipeline with per-stage timeouts and friendly per-stage error mapping; stale jobs are re-queued after worker restart; artifacts cleaned after each job (transcript and summary kept).
- STT model configurable (default `mistralai/voxtral-mini-transcribe`); transcription runs through the OpenRouter API, so no local speech tools or model volumes are needed.
- No history/queue UI, no accounts, no rate limiting, no cost tracking in v1 (explicitly out of scope).
- Not yet decided/verified: a real YouTube download on this host (YouTube bot-checks its IP; a cookies file at `~/.secrets/youtube-cookies.txt` is the documented remedy). The STT and summarization stages have been exercised against real audio via the spike.

## Brand Commitments

None. Self-hosted personal tool; no name, logo, voice, or visual identity is committed. `plan.md` is the architectural contract, not a visual one.

## Evidence on Hand

- `plan.md`: detailed architecture, API contract, prompts, compose file, and security design (the implementation contract).
- No real content yet: no sample summaries, transcripts, or validated output exist. Nothing about the pipeline's output quality has been demonstrated; future work must not fabricate user testimonials or benchmark claims.

## Product Principles

1. **The note is the product.** The Markdown must be complete, accurate to the source, and structured for later study; the UI exists to deliver it.
2. **Minimal v1.** One job at a time, no history, no accounts — only what it takes to go from URL to note, done simply and well.
3. **Private and self-hosted.** The content and the key stay on the operator's machine; the API key is never stored in plaintext.
4. **Honest failure.** Every pipeline stage reports a clear, friendly, accurate error; no silent stalls.
5. **Proven building blocks.** Only tools with a known-good contract (yt-dlp, ffmpeg, the OpenRouter STT API, pi) and a spike-verified invocation pattern go into the pipeline.

## Accessibility & Inclusion

Standard, reasonable web accessibility: semantic HTML, keyboard-operable controls, sufficient contrast, and a readable rendered-Markdown view. No additional mandated standard beyond that.
