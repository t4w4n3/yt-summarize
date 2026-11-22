// Facade for backward compat — prefer focused imports.
// - `config.ts`        → Config, config, dbPath()          (generic, sticky)
// - `domain/job/entity.ts` → STAGES, Stage, STATUS, JobStatus (supporting, stable)
// - `timeouts.ts`      → stageTimeoutMs()                   (supporting)

export type { JobStatus, Stage } from '../domain/job/entity.ts';
export { STAGES, STATUS } from '../domain/job/entity.ts';
export type { Config } from './config.ts';
export { config, dbPath } from './config.ts';
export { stageTimeoutMs } from './timeouts.ts';
