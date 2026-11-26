/**
 * Runtime settings needed by the pipeline and its outbound stage adapters.
 *
 * The interface lives in the application layer so the use-case code accepts the
 * settings as a value instead of importing the `shared/config` singleton. A
 * composition root builds the concrete object with `loadConfig(process.env)` and
 * threads it explicitly through worker/server startup.
 */
export interface RuntimeConfig {
  artifactsDir: string;
  jobTimeoutMs: number;
  sttModel: string;
  sttRetryMaxAttempts: number;
  sttRetryBaseDelayMs: number;
  sttRetryMaxDelayMs: number;
  sttRetryAfterMaxMs: number;
  llmProvider: string;
  llmModel: string;
  llmProviderPin: string;
  llmQuantization: string;
  llmThinking: string;
  mullvadEnabled: boolean;
  mullvadProxy: string;
  maxDownloadBytes: number;
}
