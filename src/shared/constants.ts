// Facade for backward compat — prefer focused imports.
// - `config.ts`      → Config, config, dbPath()        (generic, sticky)
// - `job.ts`         → STAGES, Stage, STATUS, JobStatus (supporting, stable)
// - `timeouts.ts`    → stageTimeoutMs()                (supporting)
// See docs/coupling-review.md P3 (low cohesion, mixed volatility).

export type { Config } from './config.ts';
export { config, dbPath } from './config.ts';
export type { JobStatus, Stage } from './job.ts';
export { STAGES, STATUS } from './job.ts';
export { stageTimeoutMs } from './timeouts.ts';
