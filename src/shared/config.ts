import path from 'node:path';

export interface Config {
  port: number;
  dataDir: string;
  artifactsDir: string;
  sttModel: string;
  sttRetryMaxAttempts: number;
  sttRetryBaseDelayMs: number;
  sttRetryMaxDelayMs: number;
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
  sttRetryMaxAttempts: boundedInt(process.env.STT_RETRY_MAX_ATTEMPTS, 3, 1),
  sttRetryBaseDelayMs: boundedInt(process.env.STT_RETRY_BASE_DELAY_MS, 1000, 0),
  sttRetryMaxDelayMs: boundedInt(process.env.STT_RETRY_MAX_DELAY_MS, 8000, 0),
  llmProvider: process.env.LLM_PROVIDER || 'openrouter',
  llmModel: process.env.LLM_MODEL || 'meta/muse-spark-1.3-contributor',
  llmThinking: process.env.LLM_THINKING || 'high',
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 1800000),
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 600000),
});

/**
 * Parses an integer bound from the environment.
 *
 * Falls back to `fallback` whenever the value is absent, below `min`, or not a
 * finite number — including the un-interpolated `${VAR:-default}` literal that
 * podman-compose 1.3.0 passes for a variable missing from `.env`. A bound that
 * resolves to NaN is worse than no bound: it silently disables the caller.
 */
export function boundedInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return floored >= min ? floored : fallback;
}

export function dbPath(): string {
  return path.join(config.dataDir, 'jobs.db');
}
