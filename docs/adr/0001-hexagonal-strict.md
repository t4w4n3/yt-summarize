# Hexagonal strict with fine ports and a domain/app/infra layout

Status: accepted — implemented (migration closed)

We adopt a strict hexagonal layout. `src/domain` holds the pure rules plus the job state machine. `src/application` holds the use cases (`SubmitJob`, `RunPipeline`, `RetryJob`) and the fine-grained outbound ports (`JobStore`, `ArtifactStore`, `Downloader`, `AudioConverter`, `SpeechToText`, `Summarizer`, `SecretStore`). `src/infrastructure/inbound` holds the driving adapters and composition roots: the Express API (`http.ts`) and the worker bootstrap plus polling loop (`worker.ts`, `worker-core.ts`). `src/infrastructure/outbound` holds the driven adapters: stage adapters, SQLite job store, filesystem artifact store, and the OpenRouter secret store. `src/shared/config.ts` remains the single environment reader, and `src/vpn` stays a separate sidecar process with its own env contract.

The final migration moved the pipeline orchestrator to `src/application/pipeline-runner.ts`; it receives its `JobStore`, `ArtifactStore`, stage ports, and runtime config by injection, so it never imports an adapter. `PipelineStages` is a thin application facade delegating to the fine ports, and `transcribe.ts` is the existing pattern to replicate. `friendlyError`, URL/lang validation, and dedup live in `application/`; the resume probe lives behind `ArtifactStore`; unit tests drive use cases through fakes and ArchUnit forbids any `domain`/`application` → `infrastructure` import. The legacy `src/worker` directory and the `src/shared/constants.ts` re-export facade have been removed.

## Considered Options

- Pragmatic hexagonal (domain pure only, orchestration left in worker): rejected — the user chose strict, and the resume/friendlyError boundaries are exactly where the current code leaked.
- Single coarse port (audio→note): rejected — unfakeable; every unit test would exercise the whole pipeline.
- Flat `adapters/` without `infrastructure/`: rejected — `infrastructure` makes the dependency direction (`app` depends on `infra`, never the reverse) self-evident.

## Consequences

- `domain` and `application` import no `node:*` I/O and no `process.env`; final dependencies are listed in `tests/arch/`.
- New ports must land with fakes in the same change, or the hermetic gate cannot see them.
- Composition roots (`src/infrastructure/inbound/http.ts` and `worker.ts`) are the only places allowed to build adapters and pass them into use cases.
