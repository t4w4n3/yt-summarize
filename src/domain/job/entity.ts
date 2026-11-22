/**
 * Rich Job entity — the single owner of the job lifecycle (phase 1C).
 *
 * Canonical statuses and stages live here; `shared/job.ts` re-exports them
 * so existing import paths keep working. Transitions are pure functions
 * returning a new Job or throwing `InvalidJobTransitionError`; the SQLite
 * adapter (phase 2 ports) only persists the resulting state.
 */

export const STAGES = ['downloading', 'converting', 'transcribing', 'summarizing'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
} satisfies Record<string, JobStatus>);
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  readonly id: string;
  readonly url: string;
  readonly videoId: string | null;
  readonly lang: string | null;
  readonly status: JobStatus;
  readonly stage: Stage | null;
  readonly progress: number;
  readonly title: string | null;
  readonly error: string | null;
  readonly markdown: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly updatedAt: string;
}

export class InvalidJobTransitionError extends Error {
  readonly from: JobStatus;
  readonly attempted: string;

  constructor(from: JobStatus, attempted: string, options?: ErrorOptions) {
    super(`Cannot ${attempted} a job while it is ${from}.`, options);
    this.name = 'InvalidJobTransitionError';
    this.from = from;
    this.attempted = attempted;
  }
}

export interface CreateJobParams {
  readonly id: string;
  readonly url: string;
  readonly videoId?: string | null;
  readonly lang?: string | null;
}

export function createJobEntity(params: CreateJobParams, nowISO: string): Job {
  return {
    id: params.id,
    url: params.url,
    videoId: params.videoId ?? null,
    lang: params.lang ?? null,
    status: STATUS.QUEUED,
    stage: null,
    progress: 0,
    title: null,
    error: null,
    markdown: null,
    createdAt: nowISO,
    claimedAt: null,
    lastHeartbeatAt: null,
    updatedAt: nowISO,
  };
}

export function claimJob(job: Job, nowISO: string): Job {
  if (job.status !== STATUS.QUEUED) throw new InvalidJobTransitionError(job.status, 'claim');
  return {
    ...job,
    status: STATUS.RUNNING,
    stage: null,
    progress: 0,
    claimedAt: nowISO,
    lastHeartbeatAt: nowISO,
    updatedAt: nowISO,
  };
}

export function heartbeatJob(job: Job, nowISO: string): Job {
  if (job.status !== STATUS.RUNNING) throw new InvalidJobTransitionError(job.status, 'heartbeat');
  return { ...job, lastHeartbeatAt: nowISO, updatedAt: nowISO };
}

export function updateJobStage(job: Job, stage: Stage, progress: number, nowISO: string): Job {
  if (job.status !== STATUS.RUNNING) throw new InvalidJobTransitionError(job.status, 'update stage');
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new RangeError(`Progress ${progress} is out of range (0..100).`);
  }
  return { ...job, stage, progress, updatedAt: nowISO };
}

export function markJobDone(job: Job, title: string | null, markdown: string, nowISO: string): Job {
  if (job.status !== STATUS.RUNNING) throw new InvalidJobTransitionError(job.status, 'mark done');
  return {
    ...job,
    status: STATUS.DONE,
    stage: null,
    progress: 100,
    title: title || null,
    markdown,
    error: null,
    lastHeartbeatAt: null,
    updatedAt: nowISO,
  };
}

export function markJobFailed(job: Job, error: string, stage: Stage | null, nowISO: string): Job {
  if (job.status !== STATUS.RUNNING) throw new InvalidJobTransitionError(job.status, 'mark failed');
  return { ...job, status: STATUS.FAILED, stage: stage || null, error, lastHeartbeatAt: null, updatedAt: nowISO };
}

export function retryJob(job: Job, nowISO: string): Job {
  if (job.status !== STATUS.FAILED) throw new InvalidJobTransitionError(job.status, 'retry');
  return {
    ...job,
    status: STATUS.QUEUED,
    stage: null,
    progress: 0,
    error: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    updatedAt: nowISO,
  };
}

/**
 * True when a running job has been silent longer than `staleAfterMs`.
 * Mirrors the SQL reclaim (`COALESCE(last_heartbeat_at, claimed_at, updated_at) < cutoff`):
 * exactly at the cutoff is not stale; 1ms older is. Unparseable timestamps
 * or non-running jobs are never stale (safe default: never auto-requeue
 * on garbage).
 */
export function isStaleJob(job: Job, nowMs: number, staleAfterMs: number): boolean {
  if (job.status !== STATUS.RUNNING) return false;
  const activity = job.lastHeartbeatAt ?? job.claimedAt ?? job.updatedAt;
  const activityMs = Date.parse(activity);
  if (!Number.isFinite(activityMs)) return false;
  return activityMs < nowMs - staleAfterMs;
}
