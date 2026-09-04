import path from 'node:path';

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
  sttModel: process.env.STT_MODEL || 'microsoft/mai-transcribe-2',
  llmProvider: process.env.LLM_PROVIDER || 'openrouter',
  llmModel: process.env.LLM_MODEL || 'meta/muse-spark-1.3-contributor',
  llmThinking: process.env.LLM_THINKING || 'high',
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 1800000),
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 600000),
});

export function dbPath(): string {
  return path.join(config.dataDir, 'jobs.db');
}
