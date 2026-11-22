import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../shared/config.ts';
import type { JobRow } from '../shared/db.ts';
import { heartbeat, markDone, updateStage } from '../shared/db.ts';
import { STAGES } from '../shared/job.ts';
import { stageTimeoutMs } from '../shared/timeouts.ts';
import { convert } from './stages/convert.ts';
import { download } from './stages/download.ts';
import { StageError } from './stages/process.ts';
import { summarize } from './stages/summarize.ts';
import { transcribe } from './stages/transcribe.ts';

/**
 * Any error escaping the pipeline carries the stage it failed in, so the
 * worker can attribute failures even for non-StageError exceptions.
 */
export type StagedError = Error & { stage?: string | null };

/**
 * The four outbound stages run in sequence. Injectable so tests can stub the
 * real subprocess/HTTP adapters; defaults to the real implementations.
 */
export interface PipelineStages {
  download: typeof download;
  convert: typeof convert;
  transcribe: typeof transcribe;
  summarize: typeof summarize;
}

const realStages: PipelineStages = { download, convert, transcribe, summarize };

export function stageOf(error: unknown): string | null {
  if (error instanceof StageError) return error.stage;
  if (error instanceof Error) return (error as StagedError).stage ?? null;
  return null;
}

/*
 * Artifact resume (retry without paying again).
 *
 * A retried (or stale-reclaimed) job re-enters runPipeline with its jobDir
 * intact. The probe below decides, from the artifacts on disk, which stages
 * are already done — the furthest valid artifact wins:
 *   transcript.txt (non-blank)  → resume at summarizing
 *   audio.wav (RIFF/WAVE, >44 B) → resume at transcribing
 *   audio.* (non-empty download) → resume at converting
 *   nothing valid                → run every stage
 * Validity is deliberately cheap and bounded: a stat, at most a 12-byte
 * header read, and at most a 4 KiB transcript sniff — never a full-file
 * read of a potentially hundreds-of-MB wav. Combined with the failure
 * cleanup in runPipeline (only the failed stage's partial output is
 * dropped), any artifact left on disk after a failure is a *completed*
 * stage's output, so reusing it cannot resurrect a truncated download or
 * conversion.
 */
function hasTextContent(file: string): boolean {
  try {
    if (fs.statSync(file).size === 0) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').trim().length > 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isValidWav(file: string): boolean {
  try {
    if (fs.statSync(file).size <= 44) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(12);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return n === 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The downloaded audio file (`audio.<ext>`, never `audio.wav`), if usable. */
function findDownloadedAudio(jobDir: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(jobDir).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.startsWith('audio.') || name === 'audio.wav') continue;
    const full = path.join(jobDir, name);
    try {
      if (fs.statSync(full).size > 0) return full;
    } catch {}
  }
  return undefined;
}

/** Title cached by yt-dlp (`.title`) on the previous attempt, if any. */
function readCachedTitle(jobDir: string): string | undefined {
  try {
    const title = fs.readFileSync(path.join(jobDir, '.title'), 'utf8').trim().split(/\r?\n/).at(-1)?.trim();
    return title ? title.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function rmQuietly(file: string | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

/** Remove downloaded-audio partials (`audio.*` except `audio.wav`) from a job dir. */
function removeDownloadedAudio(jobDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(jobDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('audio.') && name !== 'audio.wav') rmQuietly(path.join(jobDir, name));
  }
}

export async function runPipeline(
  db: DatabaseSync,
  job: JobRow,
  signal: AbortSignal,
  stages: PipelineStages = realStages,
): Promise<void> {
  const jobDir = path.join(config.artifactsDir, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const logPath = path.join(jobDir, 'stage.log');
  const onHeartbeat = () => heartbeat(db, job.id);
  const context = { jobDir, logPath, onHeartbeat, timeoutMs: stageTimeoutMs('downloading'), signal };
  let audioPath: string | undefined;
  let wavPath: string | undefined;
  let transcriptPath: string | undefined;
  let title: string | null = job.title ?? null;
  let currentStage: string | null = null;
  let succeeded = false;

  // Resume probe: furthest valid artifact on disk wins (see helpers above).
  const cachedTranscript = path.join(jobDir, 'transcript.txt');
  const cachedWav = path.join(jobDir, 'audio.wav');
  const resumeFromTranscript = hasTextContent(cachedTranscript);
  const resumeFromWav = !resumeFromTranscript && isValidWav(cachedWav);
  const cachedAudio = resumeFromTranscript || resumeFromWav ? undefined : findDownloadedAudio(jobDir);
  if (resumeFromTranscript || resumeFromWav || cachedAudio) {
    title = title || readCachedTitle(jobDir) || 'Untitled YouTube video';
  }
  if (resumeFromTranscript) transcriptPath = cachedTranscript;
  if (resumeFromWav) wavPath = cachedWav;
  if (cachedAudio) audioPath = cachedAudio;

  try {
    if (!resumeFromTranscript) {
      if (!resumeFromWav && !cachedAudio) {
        currentStage = STAGES[0];
        updateStage(db, job.id, currentStage, 5);
        const downloaded = await stages.download(job, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
        audioPath = downloaded.audioPath;
        title = downloaded.title;
      }

      if (!resumeFromWav) {
        currentStage = STAGES[1];
        updateStage(db, job.id, currentStage, 25);
        wavPath = await stages.convert(audioPath as string, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
        // The wav now carries everything the download did; drop the raw
        // audio early so a later failure leaves at most one copy on disk.
        rmQuietly(audioPath);
        audioPath = undefined;
      }

      currentStage = STAGES[2];
      updateStage(db, job.id, currentStage, 45);
      transcriptPath = await stages.transcribe(wavPath as string, {
        ...context,
        timeoutMs: stageTimeoutMs(currentStage),
      });
      rmQuietly(audioPath);
      rmQuietly(wavPath);
      audioPath = undefined;
      wavPath = undefined;
    }

    currentStage = STAGES[3];
    updateStage(db, job.id, currentStage, 70);
    // Legacy rows have a NULL lang column; NULL means English.
    const markdown = await stages.summarize(transcriptPath as string, {
      ...context,
      timeoutMs: stageTimeoutMs(currentStage),
      lang: job.lang || 'en',
    });
    fs.writeFileSync(path.join(jobDir, 'summary.md'), `${markdown}\n`, 'utf8');
    markDone(db, job.id, title, markdown);
    succeeded = true;
  } catch (error) {
    // Attribute first, then drop only the failed stage's partial output so
    // completed-stage artifacts survive for a retry (see probe comment).
    // In particular: transcribing/summarizing failures keep the wav, the
    // chunk transcripts and the transcript — the paid STT work is not lost.
    let failedStage: string | null = currentStage;
    if (error instanceof StageError) {
      if (!error.stage && currentStage !== null) error.stage = currentStage;
      failedStage = error.stage;
    } else if (error instanceof Error) {
      const staged = error as StagedError;
      staged.stage = staged.stage || currentStage;
      failedStage = staged.stage;
    }
    if (failedStage === STAGES[0]) {
      removeDownloadedAudio(jobDir);
      rmQuietly(path.join(jobDir, '.title'));
    } else if (failedStage === STAGES[1]) {
      rmQuietly(path.join(jobDir, 'audio.wav'));
    }
    if (error instanceof StageError || error instanceof Error) throw error;
    throw new StageError(String(error), currentStage || 'pipeline');
  } finally {
    // On success the bulky intermediates go (transcript + summary stay).
    // On failure they stay put for the retry — see catch above.
    if (succeeded) {
      removeDownloadedAudio(jobDir);
      rmQuietly(audioPath);
      rmQuietly(wavPath);
      rmQuietly(path.join(jobDir, 'audio.wav'));
    }
  }
}

export function friendlyError(error: unknown): string {
  if (error instanceof StageError) {
    const detail = error.details ? ` ${error.details.slice(-600)}` : '';
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
      if (isInfra)
        return `The download service is temporarily unavailable (network error). Please try again in a few minutes. If the problem persists, an operator should check the VPN sidecar and worker logs.${detail}`;
      return `YouTube could not provide this video. Check that it is public and the URL is correct.${detail}`;
    }
    if (error.stage === 'transcribing' && error.message.includes('model is missing')) return error.message;
    if (error.stage === 'summarizing' && /credential|auth|api key|401|403/i.test(`${error.message} ${detail}`))
      return 'The summarizer could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.';
    return `${error.message}${detail}`;
  }
  if (error instanceof Error && error.message) return error.message;
  if (error instanceof Error) return 'The worker stopped unexpectedly.';
  return typeof error === 'string' && error ? error : 'The worker stopped unexpectedly.';
}
