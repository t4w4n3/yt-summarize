# Hexagonal strict with fine ports and a domain/app/infra layout

Status: accepted

We adopt a strict hexagonal target: `src/domain` holds the pure rules plus the job state machine, `src/application` holds the use cases (`SubmitJob`, `RunPipeline`, `RetryJob`) and the fine-grained outbound ports (`JobStore`, `ArtifactStore`, `Downloader`, `AudioConverter`, `SpeechToText`, `Summarizer`, `SecretStore`), and `src/infrastructure/inbound|outbound` holds the adapters (Express `server.ts`, stage adapters, SQLite, secrets, feeders). `src/vpn` stays a separate sidecar process with its own env contract. The `PipelineStages` injection becomes a thin application facade delegating to the fine ports; `transcribe.ts` is the existing pattern to replicate. `friendlyError`, URL/lang validation and dedup live in `application/`; the resume probe lives behind `ArtifactStore`; unit tests drive use cases through fakes and archunit forbids any `domain`/`application` → `infrastructure` import.

## Considered Options

- Pragmatic hexagonal (domain pure only, orchestration left in worker): rejected — the user chose strict, and the resume/friendlyError boundaries are exactly where the current code leaks.
- Single coarse port (audio→note): rejected — unfakeable; every unit test would exercise the whole pipeline.
- Flat `adapters/` without `infrastructure/`: rejected — `infrastructure` makes the dependency direction (`app` depends on `infra`, never the reverse) self-evident.

## Consequences

- `domain` and `application` import no `node:*` I/O and no `process.env`; `final` deps are listed in `tests/arch/`.
- New ports must land with fakes in the same change, or the hermetic gate cannot see them.
