// Canonical owner is the domain entity (phase 1C); re-exported so existing
// import paths (`shared/job.ts`) keep working until the phase-2 ports.

export type { JobStatus, Stage } from '../domain/job/entity.ts';
export { STAGES, STATUS } from '../domain/job/entity.ts';
