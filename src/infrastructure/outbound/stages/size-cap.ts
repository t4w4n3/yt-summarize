import fs from 'node:fs';
import { StageError } from './process.ts';

/** User-facing message for a size-cap rejection (no internal detail). */
export const TOO_LONG_MESSAGE = 'This video is too long to process: its audio exceeds the maximum size limit.';

function appendLog(logPath: string | undefined, line: string): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {}
}

/**
 * Rejects a job whose on-disk size exceeds its cap, before the file is read
 * whole into RAM (F-1). The rejection is a terminal StageError with no
 * details: the user sees TOO_LONG_MESSAGE verbatim, the measured size and
 * the bound stay in the stage log, e.g.
 * `audio.wav 2000 bytes exceeds max WAV size 1000 bytes, rejecting`.
 */
export function assertWithinSizeCap(
  sizeBytes: number,
  capBytes: number,
  stage: string,
  logPath: string | undefined,
  fileLabel: string,
  capLabel: string,
): void {
  if (sizeBytes <= capBytes) return;
  appendLog(logPath, `${fileLabel} ${sizeBytes} bytes exceeds max ${capLabel} size ${capBytes} bytes, rejecting`);
  throw new StageError(TOO_LONG_MESSAGE, stage);
}
