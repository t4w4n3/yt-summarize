# Config injected at the composition root, migration by strangler

Status: accepted

The frozen `config` singleton imported from `domain`, `application` and the adapters is replaced by an immutable `Config` value built once with the existing `loadConfig(env)` in the two composition roots (`worker.ts`, `server.ts`) and passed explicitly into use cases, ports and stages — `domain`/`application` never read `process.env` and never import the singleton (the `config-boundary` arch test is extended to forbid it). The migration is a three-step strangler keeping the hermetic gate green: (1) move validation, dedup, resume probe and `friendlyError` behind `ArtifactStore`/application with the entity in place; (2) introduce `JobStore`/`ArtifactStore`/`SecretStore` adapters with fakes; (3) switch the bootstrap to injected config and tighten the arch rules. No big-bang rewrite.

## Considered Options

- Keep the singleton everywhere: rejected — it couples the domain to `process.env`, and `mullvadSettings()` reading `process.env` per call is already the documented exception that proves the leak.
- Big-bang layout move: rejected — `mise run test` must stay green at every step (red → green discipline), and `transcription/` is the proven pattern to copy, not a rewrite target.

## Consequences

- The single-reader guarantee (every setting through `shared/config.ts`, never raw `process.env`) becomes a construction guarantee, not a test-only scan.
- Each strangler step ships green tests before the next starts; partial steps are a deliberate, visible intermediate state, not a mess.
