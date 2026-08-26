# Progression Report — Balanced Coupling: From Review to Balanced Code

**Project:** `summarize-yt` — self-hosted YouTube → study-note workstation (Node 24, Express, SQLite, yt-dlp/ffmpeg, OpenRouter)
**Date:** 2026-08-26
**Branch:** `main` → `1db1f3a` → `e892630` (`refactor(coupling): split shared constants, unify secrets, document shared-DB — P3-P5`)
**Method:** Test-first (red → green → refactor), Balanced Coupling model (strength × distance × volatility)
**Gate:** `mise` hermetic gate — `typecheck + unit + arch (archunit) + integration + e2e (Playwright) + security + lint`

---

## 1. Context & Request

The user loaded the **Balanced Coupling** skill and asked for a full modularity review of `summarize-yt`.

Typical symptoms in the codebase that motivated the review:
- YouTube URL validation and `video_id` dedup shared the same business rule but implemented it twice (implicit functional coupling).
- Transcription (`src/worker/stages/transcribe.ts`, ~316 LoC) handled three wire strategies (`multipart → base64 → chunk`), WAV header parsing, and OpenRouter calls intrusively — the contract `src/domain/transcription/ports.ts` existed but was not wired.
- `src/shared/constants.ts` mixed unrelated volatilities; `app ↔ worker` shared SQLite via a model — tolerable for v1 but worth naming.

The goal was not to chase purity, but to apply `BALANCE = (STRENGTH xor DISTANCE) or not VOLATILITY` and fix only where volatility makes the pain real.

---

## 2. Objectives

1. **Make the coupling visible** — map every major integration on the three dimensions at two fractal levels (system: `app`/`worker`/`vpn`; module: `domain`/`shared`/`worker/stages`).
2. **Classify by volatility** in plain language:
   - **Core** (differentiating, high volatility) — transcription strategy, STT model, prompt.
   - **Supporting** (needed, low volatility) — job queue, `lang` dedup.
   - **Generic** (solved, low functional / variable impl. volatility) — yt-dlp/ffmpeg, OpenRouter auth, Mullvad SOCKS5, SQLite.
3. **Propose pragmatic fixes** ordered by `pain = strength × distance × volatility` (highest pain first).
4. **Implement P1 + P2 test-first** and prove the gate stays green.

---

## 3. Phase 1 — Review (Make it visible)

### 3.1 Artefacts inspected

- `src/domain/transcription/policy.ts` + `ports.ts`, `src/worker/pipeline.ts`, all `src/worker/stages/*`, `src/app/server.ts`, `src/shared/{constants,db}.ts`, `compose.yaml`, `image/*`, `tests/{unit,integration,arch}`, `e2e/*`, `docs/index.html` (Mermaid system view).

### 3.2 Volatility map (summary)

| Area | Plain-language subdomain | Volatility |
|---|---|---|
| `policy.ts` + `prompts/summarize.md` + `STT_MODEL`/`LLM_MODEL` | Core — the product’s edge | **High** |
| `pipeline.ts`, `shared/db.ts` queue, `lang` dedup | Supporting — CRUD/orchestration | **Low** |
| yt-dlp/ffmpeg, OpenRouter HTTPS, Mullvad, SQLite | Generic — solved; impl. volatility varies (STT switch plausible, SQLite sticky) | Low functional / variable impl. |

Single-team, single-operator context lowers effective socio-technical distance — `app ↔ worker` co-evolution is one edit + `mise run up`, not cross-team negotiation.

### 3.3 Findings (ranked)

| ID | Coupling | Strength | Distance | Volatility | Balance |
|---|---|---|---|---|---|
| **A** | `app/server.ts:extractVideoId` ↔ `shared/db.ts:extractVideoIdFromUrl` (duplicated) | Functional (implicit) | High | Low | **Tight-ish masked by `not VOLATILITY`** — harmless until YouTube rules diverge |
| **B** | `shared/constants.ts` (config + STAGES + timeouts) | Low (unrelated) | Low | Mixed | **Low cohesion** — both low → complexity |
| **C** | `transcribe.ts` intrusive fetch/fs/WAV vs `domain/ports.ts` contract (unused) | Intrusive+Functional | Low | **High** | **High cohesion today, brittle tomorrow** — designed contract not wired |
| **D** | `app ↔ worker` via `JobRow` + `jobs-data` volume | Model | High | Low | **Tight** but pragmatically balanced for v1; `shared/db.ts` facade + `publicJob` already reduce strength |
| **E** | Secret layout duplicated (`openrouter.ts` vs `download.ts`) | Intrusive | Medium | High impl. | Duplicated `fs.existsSync('/run/secrets/…')` |

**Well-balanced to keep:** `domain/policy.ts` isolation (archunit-enforced), `vpn` sidecar SOCKS5 contract (exemplary loose coupling), OpenRouter HTTPS contracts, `pipeline.ts` sequential cohesion, SQLite polling (async, no tight runtime coupling).

Full analysis shipped as **`docs/coupling-review.md`** (206 lines, 7 sections, fractal note, action plan P1–P5). Served with `mise run docs` alongside the Mermaid system view.

---

## 4. Phase 2 — Design Decisions (Make it right, not gold-plated)

| Priority | Fix | Why now | Strength shift | Effort |
|---|---|---|---|---|
| **P1** | Wire `SpeechToTextPort`/`AudioSplitterPort` into `transcribe.ts` via `TranscribeContext` injection | **Highest pain** — core, high volatility; next STT change would require surgery on 350 LoC | Intrusive → Contract (`high xor low` brittle → `low xor high` resilient) | ~0.5d |
| **P2** | Reuse `shared/db.ts:extractVideoIdFromUrl` in `app/server.ts`, make it `trim()`-aware | Tiny, high ROI — removes implicit functional coupling; archunit cannot catch duplicated knowledge | Functional (implicit) → Contract (explicit single source) | 10 min |
| **P3** | Split `shared/constants.ts` → `config.ts`/`job.ts`/`timeouts.ts` | Low cohesion, low pain (shielded by `not VOLATILITY`) | `low+low → high+low` per file | Deferred — do when touching `STT_MODEL` |
| **P4** | Consolidate secret resolution → `shared/secrets.ts` | Medium — only worth it during GPG→podman-secret migration | Intrusive duplicated → single contract | Deferred |
| **P5** | Document `app↔worker` shared-DB tradeoff, defer split until queue UI ships | Avoid premature distributed abstraction | Tight stays tight, but `not VOLATILITY` justifies it | 5 min comment (deferred) |

Principles applied:
- **Fractal:** named the observed level before judging distance.
- **Socio-technical:** single team → lower effective distance.
- **Pragmatic `not VOLATILITY`:** “Not all of a large system will be well-designed” (Evans) — deliberately left P3–P5 for later.
- **Fakes over mocks:** unit/integration tests drive through ports via in-memory fakes, not stubbed adapters beyond the boundary.

---

## 5. Phase 3 — Implementation, Test-First (Make it work → make it right)

### 5.1 Test-first setup

Two new test suites were written **before** touching production code (red → green):

- **`tests/integration/transcribe-ports.test.ts`** (P1) — drives `transcribe()` through `SpeechToTextPort`/`AudioSplitterPort` fakes:
  - *uses injected port, no fetch called* — asserts `globalThis.fetch` untouched, `attemptMultipart` called once, transcript written.
  - *413 → base64 → chunk fallback via fakes* — exercises `policy.ts` classification without real 25 MB files or ffmpeg.
  - *backwards compat* — no injection uses real `fetch` (stubbed), preserving `transcribe-boundary.test.ts` contract.
- **`tests/integration/video-id-dedup.test.ts`** (P2) — asserts `shared/db.ts:extractVideoIdFromUrl` handles whitespace/canonical forms **and** that `src/app/server.ts` imports it and defines no local `extractVideoId` (explicit contract check via `fs.readFileSync` + regex).

Placed in `tests/integration` (not `tests/unit`) to respect `archunit` rule: `tests/unit/**` must not depend on `src/worker/**` or `src/shared/db.ts` (unit = domain only).

### 5.2 Red (before production change)

```
pnpm run test:unit  → 3 failures
 ✖ P1: fetch should not be called when ports are injected (StageError)
 ✖ P1: chunk fallback — The transcription API could not be reached
 ✖ P2: app/server.ts reuses helper — AssertionError: did not match /extractVideoIdFromUrl/
```

Confirmed failing for the expected reason (ports ignored, duplicated function present).

### 5.3 Minimal production changes (green)

**`src/shared/db.ts`** (1 line):
```ts
- const url = new URL(value);
+ const url = new URL(value.trim());
```

**`src/app/server.ts`**:
```ts
- import { createJob, findExistingJobByVideoId, getJob, openDatabase } from '../shared/db.ts';
+ import { createJob, extractVideoIdFromUrl, findExistingJobByVideoId, getJob, openDatabase } from '../shared/db.ts';
- function extractVideoId(...) { ... }  // deleted 11 LoC
- const videoId = extractVideoId(url);
+ const videoId = extractVideoIdFromUrl(url);
```

**`src/worker/stages/transcribe.ts`** (316 → 366 LoC):
- Import `AudioSplitterPort`, `SpeechToTextPort`, `TranscriptionAttempt`.
- Extend `TranscribeContext` with optional `stt?` and `splitter?`.
- Keep `transcribeMultipartRaw`/`transcribeBase64Raw` (logging preserved).
- Add `responseToAttempt()` (parses `{text}` → `TranscriptionAttempt` with `httpStatus`/`ok`/`errorDetails` for policy classification) and factories `createDefaultStt(logPath)` / `createDefaultSplitter()`.
- Orchestrator: `const stt = context.stt ?? createDefaultStt(logPath)` and `splitter` analog; `chooseInitialStrategy` + `nextAfterMultipartFailure`/`nextAfterBase64Failure` now operate on `attempt.errorDetails` + `httpStatus` instead of thrown `StageError.details`. Chunk loop uses `stt.attemptMultipart` per chunk and `joinTranscriptParts`.

No schema, compose, or pipeline signature change — `pipeline.ts` call site unchanged.

### 5.4 Green (after production change) + surrounding suite

```
pnpm run typecheck          → pass
pnpm run test:unit          → 17 pass
pnpm run test:integration   → 14 pass (8 original boundary + 3 P1 + 3 P2)
pnpm run test:arch          → 9 pass
  ✔ domain ↛ worker/app/vpn/storage
  ✔ app ↛ worker, shared ↛ upward, src ↛ test fixtures, src acyclic
  ✔ unit ↛ outbound adapters (now satisfied after moving new tests to integration)
```

`transcribe-boundary.test.ts` (real fs + stubbed `fetch`) continues to pass — default adapters still call `fetch` exactly as before.

Formatting / lint: `npx biome check --write` applied; `as any` → `as unknown as TranscribeContext` to satisfy `noExplicitAny`.

### 5.5 Commit

Pre-commit hook (`hk`) runs the full gate in parallel: `doctor + lint-types + test:arch + test:integration + security (audit/trivy/gitleaks) + lint-yaml/containerfile/compose + test:unit + lint-js/shell + test:e2e`.

- **First attempt:** blocked on `lint-js` (`noExplicitAny` + long import line) — fixed via `TranscribeContext` import + biome formatting.
- **Second attempt:** gate fully green, including **e2e 13 pass** (API contract, browser flow, workstation shell, validation, language picker).

Commit created:

```
1db1f3a refactor(coupling): balance transcription via ports and unify video-id extraction (main)

 6 files changed, +553 -67
  docs/coupling-review.md
  src/app/server.ts | 15 +--
  src/shared/db.ts | 2 +-
  src/worker/stages/transcribe.ts | +156 -67 (ports wiring)
  tests/integration/transcribe-ports.test.ts (new)
  tests/integration/video-id-dedup.test.ts (new)
```

Previous HEAD: `351e628 fix(build): bust podman cache…`

`todo.md` intentionally left untracked (personal scratch, not part of the change set).

---

## 6. What Was Left Intentionally Unbalanced (before Phase 4)

| Coupling | Why not fixed at that time |
|---|---|
| `pipeline.ts` orchestrates 4 stages | **High cohesion** — its job is the sequence; splitting would create distributed monolith. |
| `transcribe` 3-strategy fallback | `high xor low` cohesive and policy already extracted; only split when adding 4th strategy (whisper.cpp/subtitles). |
| `download --proxy socks5h://` | Minimal contract (one CLI flag); intrusive part isolated to `vpn` netns. |
| `shared/db.ts` WAL+migrations+CRUD+dedup | Inside one module, `high+low` cohesive; splitting by table would be `low+low`. |
| `app↔worker` shared DB | Satisfies `BALANCE` via `not VOLATILITY` (supporting, single-team, same image, polling). Revisit only if queue/history UI ships (volatility → high). |

> Phase 4 resolved `shared/constants.ts` (P3) and `shared/secrets.ts` (P4) and documented the shared-DB tradeoff (P5) — see §8. Updated table is §9.

---

## 7. Metrics & Evidence

- **Lines:** review 206 LoC; production +89 net LoC; tests +233 LoC (both via fakes, no real 25 MB fixtures).
- **Coupling delta (core):** `transcribe` intrinsic knowledge hidden behind 2-method `SpeechToTextPort` (contract) + 1-method `AudioSplitterPort` — distance high, strength low → loose coupling.
- **Duplication delta:** 11 LoC duplicated `extractVideoId` removed, single source `extractVideoIdFromUrl` now canonical (used for dedup, backfill, and API).
- **Gate:** `typecheck` clean, `unit 17 + integration 14 + arch 9 + e2e 13` all green, `lint-js`/`shell`/`yaml`/`containerfile`/`compose` clean, `trivy` 0 vulns/misconfigs, `gitleaks` no leaks, `doctor` all ok.

---

## 8. Phase 4 — P3–P5 (continued, 2026-08-26)

> User ran `continue` on the same branch — requested to finish the deferred P3–P5 as test-first, same method as P1–P2.

### 8.1 Test-first setup (red)

Three new integration suites were written **before** touching production code (all in `tests/integration` to respect `archunit`'s `unit ↛ worker/shared/db` rule):

- **`shared-modules.test.ts`** (P3 — low cohesion) — asserts `job.ts` / `config.ts` / `timeouts.ts` exist and export the correct values, `constants.ts` is a re-export facade (no inline `STAGES`/`STAGE_TIMEOUTS`), each new module has single volatility (`job.ts` knows nothing of `config`, `config.ts` knows nothing of `STAGES`), and internal consumers (`pipeline.ts`, `db.ts`) import from focused modules.
- **`secrets-contract.test.ts`** (P4 — duplicated secret layout, high impl. volatility) — asserts `shared/secrets.ts` exists with `resolveYouTubeCookiesPath` + `resolveOpenRouterKey`, that `download.ts` and `openrouter.ts` delegate to it (no duplicated `fs.existsSync('/run/secrets/…')` + `Netscape`/`sk-or-missing` branches), and that placeholder/path knowledge lives exactly once in `shared/secrets.ts`.
- **`shared-db-contract.test.ts`** (P5 — tight Model+High-Distance) — asserts `src/shared/db.ts` and `compose.yaml` contain the `Pragmatic shared-model … Revisit if queue` comment that makes the `not VOLATILITY` tradeoff explicit.

Red run: `pnpm run test:integration` → 4 suites failed (`ENOENT src/shared/{config,job,timeouts,secrets}.ts`, `pipeline.ts` still imports from `constants.ts`, placeholder duplication still present, no pragmatic comment).

### 8.2 Minimal production changes (green)

**P3 — `shared/constants.ts` split (low cohesion → high cohesion per file):**

- Created `src/shared/job.ts` → `STAGES`, `Stage`, `STATUS`, `JobStatus` (supporting, stable).
- Created `src/shared/config.ts` → `Config`, `config`, `dbPath()` (generic, sticky) — owns `path.join` + env parsing.
- Created `src/shared/timeouts.ts` → `STAGE_TIMEOUTS`, `stageTimeoutMs()` (supporting) — imports `Stage` from `job.ts` + `config` from `config.ts`; no other knowledge.
- Rewrote `src/shared/constants.ts` as a thin re-export facade (`export { config, dbPath } from './config.ts'` etc.) for backward compat (`e2e/fake-worker` kept working via re-export, but internal `src/` now imports focused modules).
- Migrated consumers: `src/app/server.ts`, `src/shared/db.ts`, `src/worker/{pipeline,worker}.ts`, `src/worker/stages/{transcribe,summarize}.ts`, `tests/live/openrouter.live.test.ts`, `e2e/fake-worker.ts` — each now imports only what it needs (e.g., `pipeline.ts` → `config` from `config.ts`, `STAGES` from `job.ts`, `stageTimeoutMs` from `timeouts.ts`).

**P4 — `shared/secrets.ts` single contract (intrusive duplicated → loose contract):**

- Created `src/shared/secrets.ts` (shared bottom layer, no `StageError` dependency):
  - `resolveYouTubeCookiesPath(): string | null` — centralizes `fs.existsSync('/run/secrets/youtube_cookies')` + `stat` + `Netscape`/`sk-or-missing` + legacy fallback, returns path or null.
  - `resolveOpenRouterKey(): Promise<string | null>` — centralizes podman secret → `sk-or-missing` placeholder handling → legacy GPG `spawn('gpg', …)` → `OPENROUTER_API_KEY` env. Throws plain `Error` only for invalid non-placeholder secret or GPG failure; callers wrap into `StageError` so `shared ↛ worker` stays enforced by `archunit`.
- `src/worker/stages/download.ts` — deleted 22 LoC duplicated branch, now `const cookiesPath = resolveYouTubeCookiesPath()`.
- `src/worker/stages/openrouter.ts` — deleted 101 LoC, now a thin wrapper `import { resolveOpenRouterKey as resolveFromShared }` + `StageError` translation. Keeps the same public API (`resolveOpenRouterKey(): Promise<string>`) so `transcribe.ts`/`summarize.ts` are unchanged.

Balance shift: `download.ts` and `openrouter.ts` no longer each know `/run/secrets/*` + placeholder strings — one contract, one place to change when `sync-secrets.sh` evolves. Intrusive → Contract.

**P5 — Document the shared-DB tradeoff (tight but justified):**

- Added header comment to `src/shared/db.ts`: `// Pragmatic shared-model: app+worker share JobRow via jobs-data volume. Balanced today because volatility=low … Revisit if queue/history UI lands — extract JobStorePort / published language via publicJob().`
- Added matching comment above `volumes: jobs-data` in `compose.yaml`.

No runtime behavior change — purely makes `BALANCE = not VOLATILITY` explicit for the next reader.

### 8.3 Green + surrounding suite

```
pnpm run typecheck          → pass
pnpm run test:unit          → 17 pass
pnpm run test:arch          → 9 pass  (domain↛worker, shared↛upward, no cycles)
pnpm run test:integration   → 27 pass (8 boundary + 3 P1 + 3 P2 + 7 P3 + 4 P4 + 2 P5)
pnpm run test:e2e           → 13 pass (stack + UI, fake-worker via new job.ts import)
```

`archunit` still green — `shared/secrets.ts` only uses `node:fs`/`node:child_process`, never imports `worker`; `shared` → `worker` violation remains 0. `constants.ts` facade does not re-introduce `low+low` — it simply re-exports, and all internal `src/` imports now target focused modules (verified by `shared-modules.test.ts`).

### 8.4 Metrics delta (P3–P5)

- **New modules:** `config.ts` (30 LoC), `job.ts` (11 LoC), `timeouts.ts` (14 LoC), `secrets.ts` (115 LoC).
- **Facade:** `constants.ts` 51 LoC → 7 LoC (re-export, low cohesion eliminated).
- **Dedup:** `download.ts` –22 LoC, `openrouter.ts` –71 LoC net (101 → 30), single secret layout.
- **Tests:** +3 suites, +13 assertions, all via `fs.readFileSync` contract checks + real imports (no 25 MB fixtures, no mocked `fs`).
- **Coupling delta:** P3 `low+low → high+low` per file (high cohesion); P4 `intrusive duplicated (medium distance) → contract (low strength, high distance)` (loose coupling); P5 `tight Model+High-Distance` stays tight but is now **named** and shielded by `not VOLATILITY`.

## 9. What Was Left Intentionally Unbalanced (updated)

| Coupling | Why still not fixed |
|---|---|
| `pipeline.ts` orchestrates 4 stages | **High cohesion** — its job is the sequence; splitting would create distributed monolith. |
| `transcribe` 3-strategy fallback | `high xor low` cohesive and policy already extracted; only split when adding 4th strategy (whisper.cpp/subtitles). |
| `download --proxy socks5h://` | Minimal contract (one CLI flag); intrusive part isolated to `vpn` netns. |
| `shared/db.ts` WAL+migrations+CRUD+dedup | Inside one module, `high+low` cohesive; splitting by table would be `low+low`. |
| `app↔worker` shared DB | Now **documented** (`Pragmatic shared-model` in `db.ts` + `compose.yaml`). Still tight (`Model+High-Distance`) but justified via `not VOLATILITY` (supporting, single-team, polling). Revisit only if queue UI ships. |

Constants and secrets are no longer on this list — they were the actionable low-cohesion / duplicated intrusive couplings and are now balanced.

## 10. Next Steps (remaining from todo.md)

1. **Coverage** — add `c8` thresholds for `domain/policy.ts` (the `multipart → base64 → chunk` state machine) — from `todo.md`.
2. **Mutation** — `Stryker` for the same state machine.
3. **UX review** — apply `impeccable` skill to empty/loading/error/workstation states.

---

## 11. Takeaway — Why This Model Helped

- Naming **strength, distance, volatility** made trade-offs explicit instead of “coupling is bad.”
- **XOR rule** explained why both “high cohesion” and “loose coupling” are desirable — they are the two modular corners.
- **`not VOLATILITY`** gave permission to leave v1’s shared-DB tight coupling alone — the cheapest correct choice for a single-operator workstation.
- **Fractal + socio-technical** lenses prevented over-engineering across team boundaries that don’t exist.

> Modular design extended the system’s goals into the future without implementing future requirements — the transcription core can now swap providers with one fake, and the URL rule lives in one place.

---

*Generated 2026-08-26 — see `docs/coupling-review.md` for the full review and `1db1f3a` for the diff. Gate reproduced via `mise run check` (doctor+lint+test+security) and `mise run test:integration`/`test:arch`.*
