import path from 'node:path';
import type { StageContext } from './process.ts';
import { runProcess } from './process.ts';

export async function convert(audioPath: string, context: StageContext): Promise<string> {
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
  return wavPath;
}
