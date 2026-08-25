/**
 * Ports required by the transcription domain.
 *
 * Adapters (worker/stages/transcribe.ts, …) implement these interfaces over
 * real I/O; the domain only sees the contracts so tests can inject fakes.
 */

/** One attempt against the speech-to-text provider, already parsed. */
export interface TranscriptionAttempt {
  readonly httpStatus: number;
  readonly ok: boolean;
  /** Trimmed `text` field from the provider — '' when absent or on error. */
  readonly text: string;
  /** Truncated raw error body for diagnostics / limit-classification. */
  readonly errorDetails: string;
}

/**
 * Outbound port to the speech-to-text provider.
 *
 * Stage adapters implement the wire details (multipart vs base64 encoding,
 * FormData construction, auth headers). The domain planner doesn't construct
 * HTTP — it only interprets attempts via the policy predicates.
 */
export interface SpeechToTextPort {
  attemptMultipart(wavPath: string, apiKey: string, signal: AbortSignal): Promise<TranscriptionAttempt>;
  attemptBase64(wavPath: string, apiKey: string, signal: AbortSignal): Promise<TranscriptionAttempt>;
}

/**
 * Outbound port for splitting a WAV into time-aligned chunks.
 *
 * Implemented by the transcribe stage via splitWavManual / ffmpeg fallback.
 * The domain doesn't care about headers or sample rates — only that chunk
 * paths are returned and cleaned up by the caller.
 */
export interface AudioSplitterPort {
  splitIntoChunks(wavPath: string, jobDir: string, chunkDurationSec: number): Promise<string[]>;
}
