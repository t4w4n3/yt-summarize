/**
 * Outbound port for job persistence. The application layer owns this
 * contract; the SQLite adapter in `shared/db.ts` implements it.
 */
import type { Job, JobStatus, Stage } from '../../domain/job/entity.ts';

export interface CreateJobInput {
  readonly id: string;
  readonly url: string;
  readonly videoId?: string | null;
  readonly lang?: string | null;
}

export interface JobStore {
  create(input: CreateJobInput): Job | null;
  get(id: string): Job | null;
  findExisting(videoId: string | null, lang: string): Job | null;
  claimNext(): Job | null;
  reclaimStaleJobs(staleAfterMs: number): number;
  updateStage(id: string, stage: Stage, progress: number): Job | null;
  heartbeat(id: string): Job | null;
  markDone(id: string, title: string | null, markdown: string): Job | null;
  markFailed(id: string, error: string, stage: string | null): Job | null;
  retryFailed(id: string): Job | null;
}

export type { JobStatus };
