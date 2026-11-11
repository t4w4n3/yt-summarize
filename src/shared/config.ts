import path from 'node:path';

/** Matches a whole-value compose expression: `${VAR}` or `${VAR:-default}`. */
const COMPOSE_EXPRESSION = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/s;

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
  /** OpenRouter provider slug the summarization model is pinned to (blank = no pin). */
  llmProviderPin: string;
  /** Quantization filter applied to the pinned provider (blank = any quantization). */
  llmQuantization: string;
  llmThinking: string;
  pollMs: number;
  jobTimeoutMs: number;
  staleAfterMs: number;
}

export const config: Config = Object.freeze({
  port: boundedInt(process.env.PORT, 8080, 1),
  dataDir: envVar(process.env.DATA_DIR, '/data'),
  artifactsDir: envVar(process.env.ARTIFACTS_DIR, '/artifacts'),
  sttModel: envVar(process.env.STT_MODEL, 'microsoft/mai-transcribe-2'),
  sttRetryMaxAttempts: boundedInt(process.env.STT_RETRY_MAX_ATTEMPTS, 3, 1),
  sttRetryBaseDelayMs: boundedInt(process.env.STT_RETRY_BASE_DELAY_MS, 1000, 0),
  sttRetryMaxDelayMs: boundedInt(process.env.STT_RETRY_MAX_DELAY_MS, 8000, 0),
  llmProvider: envVar(process.env.LLM_PROVIDER, 'openrouter'),
  llmModel: envVar(process.env.LLM_MODEL, 'deepseek/deepseek-v4.1-flash-1017'),
  llmProviderPin: envVar(process.env.LLM_PROVIDER_PIN, 'deepinfra'),
  llmQuantization: envVar(process.env.LLM_QUANTIZATION, 'fp8'),
  llmThinking: envVar(process.env.LLM_THINKING, 'high'),
  pollMs: boundedInt(process.env.WORKER_POLL_MS, 2000, 1),
  jobTimeoutMs: boundedInt(process.env.JOB_TIMEOUT_MS, 1800000, 1),
  staleAfterMs: boundedInt(process.env.STALE_AFTER_MS, 600000, 1),
});

/**
 * Reads the value out of an un-interpolated compose expression.
 *
 * podman-compose 1.3.0 substitutes only variables it finds (in `.env` or the
 * host environment); for a missing variable it hands the container the raw
 * expression. So `${VAR:-true}` means "use the default written in compose.yaml"
 * and a bare `${VAR}` means "unset":
 *
 *   unwrapComposeLiteral('${VAR:-true}') → 'true'
 *   unwrapComposeLiteral('${VAR}')       → undefined
 *   unwrapComposeLiteral('true')         → 'true'  (not an expression)
 */
export function unwrapComposeLiteral(raw: string): string | undefined {
  const match = COMPOSE_EXPRESSION.exec(raw);
  if (!match) return raw;
  return match[2];
}

/** Environment string, with the compose expression unwrapped; blank means unset. */
export function envVar(raw: string | undefined, fallback: string): string {
  const value = raw === undefined ? undefined : unwrapComposeLiteral(raw);
  return value === undefined || value.trim() === '' ? fallback : value;
}

/** Environment flag: 'true'/'false' as written, the compose default, or `fallback`. */
export function envBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw === undefined ? undefined : unwrapComposeLiteral(raw)?.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Mullvad proxy settings for yt-dlp, read on each call (tests and operators
 * change the environment at runtime). Defaults mirror compose.yaml/.env.example:
 * the tunnel is off unless enabled, and the sidecar proxy is the loopback SOCKS5.
 */
export function mullvadSettings(): { enabled: boolean; proxy: string } {
  return {
    enabled: envBool(process.env.MULLVAD_ENABLED, false),
    proxy: envVar(process.env.MULLVAD_PROXY, 'socks5h://127.0.0.1:1080'),
  };
}

/**
 * Parses an integer bound from the environment.
 *
 * Falls back to `fallback` whenever the value is absent, blank, below `min`, or
 * not a finite number. A bound that resolves to NaN is worse than no bound: it
 * silently disables the caller (`n < NaN` is false, so a retry loop vanishes).
 */
export function boundedInt(raw: string | undefined, fallback: number, min: number): number {
  const value = raw === undefined ? undefined : unwrapComposeLiteral(raw);
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return floored >= min ? floored : fallback;
}

export function dbPath(): string {
  return path.join(config.dataDir, 'jobs.db');
}
