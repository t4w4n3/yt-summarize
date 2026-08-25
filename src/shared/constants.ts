import path from 'node:path';

export const STAGES = ['downloading', 'converting', 'transcribing', 'summarizing'] as const;
export type Stage = (typeof STAGES)[number];

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
} satisfies Record<string, JobStatus>);
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Config {
  port: number;
  dataDir: string;
  artifactsDir: string;
  sttModel: string;
  llmProvider: string;
  llmModel: string;
  llmThinking: string;
  pollMs: number;
  jobTimeoutMs: number;
  staleAfterMs: number;
}

export const config: Config = Object.freeze({
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || '/data',
  artifactsDir: process.env.ARTIFACTS_DIR || '/artifacts',
  sttModel: process.env.STT_MODEL || 'mistralai/voxtral-mini-transcribe',
  llmProvider: process.env.LLM_PROVIDER || 'openrouter',
  llmModel: process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash-0731',
  llmThinking: process.env.LLM_THINKING || 'high',
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 1800000),
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 600000),
});

const STAGE_TIMEOUTS: Record<Stage, number> = Object.freeze({
  downloading: 10 * 60 * 1000,
  converting: 15 * 60 * 1000,
  transcribing: 25 * 60 * 1000,
  summarizing: 10 * 60 * 1000,
});

export function dbPath(): string {
  return path.join(config.dataDir, 'jobs.db');
}

export function stageTimeoutMs(stage: Stage | string): number {
  return STAGE_TIMEOUTS[stage as Stage] || config.jobTimeoutMs;
}
