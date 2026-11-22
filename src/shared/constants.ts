// Facade for backward compat — prefer focused imports.
// - `config.ts`        → Config, config, dbPath()          (generic, sticky)
// - application/config-timeouts.ts / application/stage-timeouts.ts → stageTimeoutMs() (supporting)
// - domain/job/entity.ts → STAGES, Stage, STATUS, JobStatus (supporting, stable)

export { stageTimeoutMs } from '../application/stage-timeouts.ts';
export type { JobStatus, Stage } from '../domain/job/entity.ts';
export { STAGES, STATUS } from '../domain/job/entity.ts';
export type { Config } from './config.ts';
export { config, dbPath } from './config.ts';
