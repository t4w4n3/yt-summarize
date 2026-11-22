# Rich Job entity with transitions owned by the domain

Status: accepted

The job is modeled as a small rich entity rather than a shared SQL row: a status union `queued | running | done | failed`, an optional stage, and explicit transition methods (`claim`, `heartbeat`, `markDone`, `markFailed`, `retry`) that reject illegal moves (e.g. retry from `done`, claim of a `running` job) before anything is persisted. The `JobStore` port is its persistence adapter only — it stores the state the entity produced, it never decides. Timeout, heartbeat and stale-reclaim are domain rules with thresholds injected as config values, so the stranded-job policy is unit-testable without clocks or threads.

## Considered Options

- Shared `JobRow` (raw 13-column row flowing through app+worker via the volume): rejected — the tight model+distance coupling the old `db.ts` comment already called out, and it leaves every invariant to whoever remembers to check.
- Persisted transition enforcement only (SQL CHECK, conditional UPDATE, `BEGIN IMMEDIATE`): rejected — the database becomes the only place that can say no, and tests must boot SQLite to prove an illegal move is refused.
- Use-case preconditions with a plain-data entity: rejected — the same rule must be enforced from three entry points (submit, poll loop, HTTP retry); one entity method at one place is the only place that cannot drift.

## Consequences

- Every new job transition needs an entity method plus a unit test at the boundary; SQL stays a persistence detail.
- `server.ts` (submit/retry) and `worker-core.ts` (claim/heartbeat/fail) both call the entity first, then `JobStore` — no silent status writes anywhere.
