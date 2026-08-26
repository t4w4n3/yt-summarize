export const STAGES = ['downloading', 'converting', 'transcribing', 'summarizing'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
} satisfies Record<string, JobStatus>);
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
