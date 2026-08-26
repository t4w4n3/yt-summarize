# Balanced Coupling — Modularity Review: `summarize-yt`

> System + Module levels, single-team context. Applied the three dimensions (integration strength, distance, volatility) and the balance rule `BALANCE = (STRENGTH xor DISTANCE) or not VOLATILITY`.

---

## 0. How to read this review

- **Integration strength** = how much knowledge is shared (intrusive > functional > model > contract). Higher strength = more likely a change cascades.
- **Distance** = cost of a cascading change (code structure + org structure + runtime). Higher distance = more expensive to co-evolve.
- **Volatility** = probability a component needs to change at all. Explained in plain language:
  - **Core** — the differentiating, "interesting" work the business actively invests in. Changes frequently.
  - **Supporting** — needed but not differentiating, no off-the-shelf solution. Mostly stable CRUD/ETL.
  - **Generic** — solved problem with ready-made solutions. Functionality is stable, but the specific provider or tech may still be swapped.
- **Balance rule:** `MODULARITY = STRENGTH xor DISTANCE`. One high, one low = modular (loose coupling or high cohesion). Both high or both low = complexity. `not VOLATILITY` can neutralize an otherwise unbalanced coupling.
- **Fractal:** distance is relative to the observed level. In a single-repo project, cross-module (`app` ↔ `worker`) *is* the highest distance, even though both ship in one image. The same pair can look balanced at one level and unbalanced at another — always name the level.

Socio-technical context: `summarize-yt` is a single-person, single-team, self-hosted workstation. Effective distance is lower than code suggests — coordinating a change across `app` and `worker` is one edit + `mise run up`, not cross-team negotiation. Many high-distance couplings are therefore cheaper than they would be in a multi-team org.

---

## 1. Volatility map

| Area | Subdomain (plain language) | Volatility | Evidence |
|---|---|---|---|
| `src/domain/transcription/policy.ts` + `prompts/summarize.md` + `STT_MODEL`/`LLM_MODEL` | **Core** — transcription strategy (`multipart → base64 → chunk`) and note structure are the product's edge | **High** | actively tuned (25 MB limit bug `FSWl57UR4k0`, chunk alignment, prompt iterations) |
| `src/worker/pipeline.ts`, `src/shared/db.ts` queue (`claimNextJob`/`heartbeat`/`reclaimStaleJobs`), `lang` dedup | **Supporting** — job orchestration, dedup per video+lang | **Low** | CRUD, one-job-at-a-time by design, schema migrated twice (`video_id`, `lang`) but rarely |
| `yt-dlp` / `ffmpeg` invocation, OpenRouter HTTPS, Mullvad SOCKS5, `node:sqlite` WAL | **Generic** — solved, buy-don't-build | **Low functional, variable impl.** | `yt-dlp`/`ffmpeg` stable; **STT provider switching is plausible** (core-adjacent) so keep contract strong; **Mullvad relay rotation** is implementation-volatile (`mise run mullvad scan`) |

---

## 2. What is already well-balanced (keep)

| Coupling | Strength | Distance | Volatility | Verdict |
|---|---|---|---|---|
| **Domain `policy.ts` isolated** — pure fns, imports nothing, `archunit` forbids `domain → worker/app/vpn/shared/db` | Contract (callers import explicit fns) | High (far from adapters) | High (core) | **Loose coupling = modular.** Unit tests drive it via fakes, never via real HTTP/fs. |
| **VPN sidecar** — only contract is `MULLVAD_PROXY=socks5h://127.0.0.1:1080` + SOCKS5 protocol, WireGuard isolated to its own netns | Contract (weakest) | Very High (separate netns, `NET_ADMIN`, own lifecycle) | Low (generic) | **Loose coupling = modular.** Only `yt-dlp --proxy` touches the tunnel; `app`/`worker` never do. Exemplary — high distance balanced by low strength. |
| **OpenRouter STT/Chat** — `transcribe.ts`/`summarize.ts` → `https://openrouter.ai` via `Authorization: Bearer` + JSON (`model`, `input_audio`/`messages`) | Contract | Very High (cross-org, network) | High impl. volatility | **Loose coupling = modular.** Provider swap is one `config.sttModel` + contract field, not DB surgery. `resolveOpenRouterKey()` encapsulates GPG/podman-secret detail behind a contract. |
| **Pipeline stages `download → convert → transcribe → summarize`** — sequential orchestration in `pipeline.ts`, share `jobDir`/`logPath` via `StageContext`, cleanup in `finally` | Intrusive + Functional (filesystem as private interface) | Low (same process, same `worker` container) | High (core) | **High cohesion = modular.** High strength balanced by low distance — cheap to co-evolve. Splitting across services would invert to tight coupling. |
| **Polling via SQLite** — `app` writes `queued`, `worker` `BEGIN IMMEDIATE; SELECT … queued; UPDATE … running`, `heartbeat` every 10s | Async polling (no direct HTTP) | Medium-High (separate containers, shared volume) | Low (supporting) | **Pragmatically balanced.** No tight runtime coupling (failure doesn't cascade synchronously). Increased effective distance compensated by weak contract (`shared/db.ts` API, not raw SQL in callers). |
| **`shared/db.ts` as contract facade** — callers use `createJob`/`getJob`/`markDone`/`markFailed`, not raw `db.prepare` everywhere | Contract (wrapping intrusive SQL) | Medium-High | Low | **Loose coupling.** Alternative (each service doing raw SQL) would be intrusive + high distance = distributed monolith. |

Enforcement is executable: `tests/arch/architecture.test.ts` (`archunit`) fails the build if `domain → worker/app/vpn`, `shared → app/worker`, or `app → worker` leaks. Socio-technical distance is codified.

---

## 3. Unbalanced or fragile couplings (ranked by pain = strength × distance × volatility)

### A. `app/server.ts` ↔ `shared/db.ts` — duplicated `extractVideoId` → Implicit Functional Coupling

`shared/db.ts` exports `extractVideoIdFromUrl` (tested, used for `video_id` dedup/backfill). `app/server.ts` re-implements the same rule as local `extractVideoId` + `validateYouTubeUrl` (hostname allowlist, `v` param vs `youtu.be` path, 11-char regex, `/watch` check).

- **Strength:** Functional (duplicated knowledge) + **implicit** — no import edge, `archunit` cannot catch it. A YouTube URL rule change must be made in two places or the system goes inconsistent.
- **Distance:** High (cross-service, cross-module) — at module level it's the highest distance available.
- **Volatility:** Low (generic URL shape) → `not VOLATILITY` partially neutralizes today, but will hurt if Shorts or new hosts are added.

> Balance: **Tight-ish (high strength + high distance)** but low volatility masks it. Classic "harmless until it isn't."

### B. `shared/constants.ts` — Low Cohesion (Low Strength + Low Distance = Complexity)

`config` (env → `PORT`/`DATA_DIR`/`STT_MODEL`/`LLM_MODEL`), `STAGES`/`STATUS`, `STAGE_TIMEOUTS`, `dbPath()`, `stageTimeoutMs()` all live together. Consumers pull one slice but depend on the whole file.

- **Strength:** Low (unrelated knowledge co-located, not high cohesion)
- **Distance:** Low (same `shared` folder, imported everywhere)
- **Volatility:** Mixed — `STT_MODEL`/`LLM_MODEL` (core, high) churns more than `STATUS` enum (supporting, low). Unrelated volatilities are coupled.

> Balance: **Low cohesion / big ball of shared** — violates `STRENGTH xor DISTANCE` (both low). Raises cognitive load; not a system breaker due to `not VOLATILITY` largely shielding it.

### C. `transcribe.ts` — Aspirational contract, actual intrusive coupling

`src/domain/transcription/ports.ts` defines `SpeechToTextPort` + `AudioSplitterPort` as the intended integration contract. Production `transcribe.ts` **does not implement them** — it directly `fetch`es OpenRouter, `fs.readFile`s the WAV, parses the RIFF header (`readUInt16LE(20)`, `blockAlign`, `byteRate`), slices PCM, and falls back to `ffmpeg`. Policy (`chooseInitialStrategy`/`nextAfter…`/`alignedChunkBytes`) is correctly delegated to `domain/policy.ts`, but I/O remains intrusive.

- **Strength:** Intrusive + Functional (knows WAV layout, `FormData` vs `base64:input_audio` wire format)
- **Distance:** Low (inside `worker`) → currently **high cohesion**, so balanced.
- **Volatility:** High (core — 25 MB limit, `CHUNK_DURATION_SEC`, `ffmpeg` vs manual split). Adding `whisper.cpp` or subtitles fast-path will force surgery on a 350-line stage.

> Balance: Balanced today (`high xor low = modular`) but **brittle against the next core change**. The `ports.ts` contract was designed for exactly this volatility but isn't wired.

### D. `app ↔ worker` via shared SQLite schema + `jobs-data` volume

Both services depend on `JobRow` shape (`video_id`, `lang`, `stage`, `progress`, `markdown`) and volume lifecycle.

- **Strength:** Model (shared domain model)
- **Distance:** High (separate containers, logically separate lifecycles, sync via DB polling)
- **Volatility:** Low (supporting) → `not VOLATILITY` saves it. Schema migrated twice with backfill — evidence it does change, but rarely.

> Balance: Technically **tight coupling** (`high + high`) but **pragmatically balanced** for v1's single-image, single-team tradeoff (`compose.yaml` `jobs-data:/data`). Would become #1 risk if queue/history UI lands (volatility jumps to high) — then the shared model should become a published contract (`publicJob` is already a step) or an `app`-owned read API.

### E. Secret branching duplicated: `download.ts` cookies vs `openrouter.ts` key

Both do `fs.existsSync('/run/secrets/…')` → placeholder checks (`sk-or-missing`, `Netscape`) → fallback to legacy GPG/mount → env escape hatch. Knowledge of secret layout is spread across `sync-secrets.sh`, `compose.yaml` `secrets:`, and two stage files.

- **Strength:** Intrusive (knows file paths, placeholder strings)
- **Distance:** Medium (duplicated knowledge across `download.ts`/`openrouter.ts`)
- **Volatility:** High impl. volatility (migration GPG → podman secret ongoing)

> Balance: High cohesion inside `worker` (tolerable), but cross-file duplication is implicit functional coupling. Consolidate behind one `resolveSecret` contract.

---

## 4. Recommendations (in volatility order — highest pain first)

### P1 — Wire the contract you already designed (core, cheap win)

Make `transcribe.ts` implement `SpeechToTextPort` + `AudioSplitterPort` and allow injection via `TranscribeContext`. Keep the current `pipeline.ts` call site working with defaults:

```ts
export function createTranscribeStage(deps: {
  stt: SpeechToTextPort
  splitter: AudioSplitterPort
  resolveKey: () => Promise<string>
}) { /* ... */ }
```

- Production `transcribe()` calls `createTranscribeStage(defaultStt, defaultSplitter, resolveOpenRouterKey)`.
- Unit tests inject fakes — no `globalThis.fetch` stubbing, no real WAV on disk needed to test the `multipart → base64 → chunk` policy edge.
- Domain policy decides; adapters only execute. `splitWavManual` hides behind `AudioSplitterPort` — callers never see `readUInt16LE`.

*Shift:* Intrusive → Contract. `high xor low (brittle)` → `low xor high (resilient)` for adapters, `low xor low` for policy. Effort ~0.5d, zero schema change. Do this **before** any STT work.

### P2 — Eliminate duplicated `extractVideoId` (supporting, 10 min, high ROI)

```ts
// src/app/server.ts
import { extractVideoIdFromUrl } from '../shared/db.ts'
// delete local extractVideoId(), reuse shared one
// keep validateYouTubeUrl locally only for HTTP 400 messaging
```

Add 10 fixtures asserting `validateYouTubeUrl` and `extractVideoIdFromUrl` agree (youtu.be, `watch?v=`, `music.youtube.com`, with `&t=`). Make `shared/db.ts` handle `.trim()` so both call sites behave identically.

*Shift:* Functional (implicit, duplicated) → Contract (explicit, single source). `high xor high (complex)` → `low xor high (modular)`.

### P3 — Fix low cohesion in `shared/constants.ts` (supporting/generic, opportunistic)

Split into focused modules, each with single volatility:

```
src/shared/config.ts      → config, dbPath(), env parsing  (generic, sticky)
src/shared/job.ts         → STAGES, STATUS, JobStatus, Stage (supporting, stable)
src/shared/timeouts.ts    → STAGE_TIMEOUTS, stageTimeoutMs() (supporting)
```

Consumers import only what they need. `high cohesion` per file. Do this next time you touch `STT_MODEL` — otherwise leave it (`not VOLATILITY` shields it).

### P4 — Consolidate secret resolution (generic, migration-driven)

```ts
// src/shared/secrets.ts — single contract
export async function resolveSecret(name: 'openrouter_key' | 'youtube_cookies'): Promise<string | null>
```

Both `download.ts` and `openrouter.ts` call it. When GPG → podman secret finishes, delete one file, not two branches. Only worth doing because the migration is in-flight.

### P5 — Document the `app ↔ worker` shared-DB tradeoff, don't "fix" it yet

Current polling via `jobs-data` volume is the conscious v1 minimalism (`PRODUCT.md`). Don't introduce a synchronous `app` HTTP API for `worker` to POST results — that trades cheap `BEGIN IMMEDIATE` polling for higher runtime coupling with no volatility to justify it.

Add a comment in `compose.yaml` + `src/shared/db.ts`:

```ts
// Pragmatic shared-model: app+worker share JobRow via jobs-data volume.
// Balanced today because volatility=low & single-team distance is low.
// Revisit if queue UI lands — extract JobStorePort / published language.
```

If queue/history ships (volatility → high), evolve to write-only `worker` / read-only `app` via a narrow `JobStorePort`, using `publicJob()` as the published language.

---

## 5. What to leave alone — intentionally unbalanced but harmless

| Coupling | Why not to fix |
|---|---|
| `pipeline.ts` orchestrates all 4 stages | That's **high cohesion** — its job is the sequence. Splitting would create `high+high = tight coupling` (distributed monolith). |
| `transcribe.ts` 3-strategy fallback | `high xor low = cohesive` and policy is already extracted. Only split when adding a 4th strategy. |
| `download.ts` knows `--proxy socks5h://…` string | Minimal contract (one CLI flag); intrusive part is isolated to `vpn` sidecar. |
| `shared/db.ts` does WAL + migrations + CRUD + dedup | Inside one module, `low+high cohesion` — splitting by table would be `low+low = low cohesion`. |

These satisfy `BALANCE` via `not VOLATILITY` — not every part of a large system needs to be well-designed (Evans). `archunit` already guards the important invariant: `domain` stays pure.

---

## 6. Action plan

| # | Change | Effort | Pain removed | When |
|---|---|---|---|---|
| P1 | Wire `SpeechToTextPort`/`AudioSplitterPort` | ~0.5d | High — next STT switch = 1 file | Before any STT work |
| P2 | Reuse `extractVideoIdFromUrl` in `app` | 10 min | Low today, prevents divergence | Next PR |
| P4 | `shared/secrets.ts` | 30 min | Medium — cleans migration | During secret migration |
| P3 | Split `constants.ts` | 20 min | Low — readability | Next time you touch `STT_MODEL` |
| P5 | Comment + defer DB split | 5 min | Avoids premature abstraction | Now; revisit only if queue UI ships |

---

## 7. Fractal note

- **System level** (`app` vs `worker` vs `vpn`): highest distance = cross-service. `vpn` exemplifies the target; `app↔worker` is intentionally tighter for v1.
- **Module level** (`domain` vs `shared` vs `worker/stages`): highest distance = cross-module import. `app → worker` is correctly forbidden by `archunit`.
- **Stage level** (`transcribe.ts` internals): highest distance = function boundaries. `policy.ts` fns vs I/O helpers correctly live low-distance, high-cohesion.

Name the level before judging balance.

---

*Generated for `summarize-yt` — Balanced Coupling review. See also `docs/index.html` (Mermaid system view) and `tests/arch/architecture.test.ts` (executable boundaries).*
