/**
 * Friendly error mapping owned by the application layer (phase 1D).
 * Converts stage-attributed errors into user-facing messages without
 * leaking internals. `StageError.details` (paths, proxy URLs, provider
 * bodies) is used only to classify the failure — it is never part of the
 * returned string, so it never reaches `job.error` (served by the API).
 * Details stay in the worker logs (`console.error` on the full error).
 * Pure function — no I/O, no config.
 */
import { type StagedError, StageError } from './errors.ts';

export function stageOf(error: unknown): string | null {
  if (error instanceof StageError) return error.stage;
  if (error instanceof Error) return (error as StagedError).stage ?? null;
  return null;
}

export function friendlyError(error: unknown): string {
  if (error instanceof StageError) {
    if (error.stage === 'downloading') {
      const searchable = `${error.message} ${error.details}`.toLowerCase();
      const isInfra =
        searchable.includes('connection refused') ||
        searchable.includes('connection timed out') ||
        searchable.includes('network is unreachable') ||
        searchable.includes('connection reset') ||
        searchable.includes('econnrefused') ||
        searchable.includes('econnreset') ||
        searchable.includes('etimedout') ||
        searchable.includes('ehostunreach') ||
        searchable.includes('transporterror') ||
        searchable.includes('proxy') ||
        searchable.includes('socks') ||
        searchable.includes('timed out');
      const isSizeCap = searchable.includes('max-filesize') || searchable.includes('maximum download size');
      if (isSizeCap) {
        // The post-download check carries the configured limit in its own
        // message; the yt-dlp abort only knows a generic exit code.
        if (error.message.includes('maximum download size')) return error.message;
        return 'This video is too long to process: its audio exceeds the download size limit.';
      }
      if (isInfra)
        return 'The download service is temporarily unavailable (network error). Please try again in a few minutes. If the problem persists, an operator should check the VPN sidecar and worker logs.';
      return 'YouTube could not provide this video. Check that it is public and the URL is correct.';
    }
    if (error.stage === 'transcribing' && error.message.includes('model is missing')) return error.message;
    if (error.stage === 'summarizing' && /credential|auth|api key|401|403/i.test(`${error.message} ${error.details}`))
      return 'The summarizer could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.';
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  if (error instanceof Error) return 'The worker stopped unexpectedly.';
  return typeof error === 'string' && error ? error : 'The worker stopped unexpectedly.';
}
