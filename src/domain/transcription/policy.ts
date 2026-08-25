/**
 * Pure transcription policy — the domain's answer to the OpenRouter
 * 25 MB upload limit.
 *
 * This module owns every *decision* the transcription use case makes:
 *  - which wire strategy to try first,
 *  - how to classify a failure as "try the next strategy",
 *  - chunk math that preserves sample-alignment.
 *
 * It imports nothing from the worker/app layers. Stages import it.
 */

export const MULTIPART_LIMIT = 24 * 1024 * 1024;

export const CHUNK_DURATION_SEC = 600;

export function fitsMultipart(sizeBytes: number): boolean {
  return sizeBytes <= MULTIPART_LIMIT;
}

export function isMultipartLimitError(message: string): boolean {
  return message.includes('413') || message.includes('25 MB') || message.includes('input_audio');
}

export function isBase64LimitError(message: string): boolean {
  return message.includes('413') || message.includes('25 MB');
}

export function chooseInitialStrategy(sizeBytes: number): 'multipart' | 'base64' {
  return fitsMultipart(sizeBytes) ? 'multipart' : 'base64';
}

export function nextAfterMultipartFailure(errorMessage: string): 'base64' | null {
  return isMultipartLimitError(errorMessage) ? 'base64' : null;
}

/**
 * What to do when a base64 attempt fails.
 *
 * Production rule (transcribe.ts): `if (!is413 && size <= LIMIT) throw;`
 * otherwise fall through to chunking. So: any error on a file that was
 * already large is treated as "buffer the whole thing is too big, split it",
 * and only small files demand a clear limit marker before chunking.
 */
export function nextAfterBase64Failure(errorMessage: string, fileSizeBytes: number): 'chunk' | null {
  const isLarge = fileSizeBytes > MULTIPART_LIMIT;
  const is413 = isBase64LimitError(errorMessage);
  return isLarge || is413 ? 'chunk' : null;
}

export function alignedChunkBytes(
  bytesPerSec: number,
  blockAlign: number,
  chunkDurationSec: number = CHUNK_DURATION_SEC,
): number {
  const raw = bytesPerSec * chunkDurationSec;
  return Math.floor(raw / blockAlign) * blockAlign;
}

export function joinTranscriptParts(parts: string[]): string {
  return parts.join('\n\n');
}
