import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from '../../../application/config.ts';
import { loadConfig } from '../../../shared/config.ts';
import type { StageContext } from './process.ts';
import { runProcess } from './process.ts';
import { assertWithinSizeCap } from './size-cap.ts';

export async function convert(
  audioPath: string,
  context: StageContext,
  runtimeConfig?: RuntimeConfig,
): Promise<string> {
  const cfg = runtimeConfig ?? loadConfig(process.env);
  const wavPath = path.join(context.jobDir, 'audio.wav');
  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      audioPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ],
    {
      stage: 'converting',
      timeoutMs: context.timeoutMs,
      logPath: context.logPath,
      onHeartbeat: context.onHeartbeat,
      signal: context.signal,
    },
  );
  // F-1: bound the converted WAV before any stage reads it whole into RAM.
  // The output format is fixed (16 kHz mono), so its byte size is its duration.
  const size = (await fs.promises.stat(wavPath)).size;
  assertWithinSizeCap(size, cfg.maxWavBytes, 'converting', context.logPath, 'audio.wav', 'WAV');
  return wavPath;
}
