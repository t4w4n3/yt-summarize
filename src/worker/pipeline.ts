import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config, STAGES, stageTimeoutMs } from '../shared/constants.ts';
import type { JobRow } from '../shared/db.ts';
import { heartbeat, markDone, updateStage } from '../shared/db.ts';
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

export function stageOf(error: unknown): string | null {
  if (error instanceof StageError) return error.stage;
  if (error instanceof Error) return (error as StagedError).stage ?? null;
  return null;
}

export async function runPipeline(db: DatabaseSync, job: JobRow, signal: AbortSignal): Promise<void> {
  const jobDir = path.join(config.artifactsDir, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const logPath = path.join(jobDir, 'stage.log');
  const onHeartbeat = () => heartbeat(db, job.id);
  const context = { jobDir, logPath, onHeartbeat, timeoutMs: stageTimeoutMs('downloading'), signal };
  let audioPath: string | undefined;
  let wavPath: string | undefined;
  let transcriptPath: string | undefined;
  let currentStage: string | null = null;

  try {
    currentStage = STAGES[0];
    updateStage(db, job.id, currentStage, 5);
    const downloaded = await download(job, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    audioPath = downloaded.audioPath;

    currentStage = STAGES[1];
    updateStage(db, job.id, currentStage, 25);
    wavPath = await convert(audioPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });

    currentStage = STAGES[2];
    updateStage(db, job.id, currentStage, 45);
    transcriptPath = await transcribe(wavPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    try {
      fs.rmSync(audioPath, { force: true });
    } catch {}
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {}

    currentStage = STAGES[3];
    updateStage(db, job.id, currentStage, 70);
    const markdown = await summarize(transcriptPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    fs.writeFileSync(path.join(jobDir, 'summary.md'), `${markdown}\n`, 'utf8');
    markDone(db, job.id, downloaded.title, markdown);
  } catch (error) {
    if (error instanceof StageError) {
      // Keep an existing stage; only fill it in when the pipeline got far
      // enough to enter a stage. A null currentStage stays null so the DB
      // keeps storing NULL for pre-pipeline failures.
      if (!error.stage && currentStage !== null) error.stage = currentStage;
      throw error;
    }
    if (error instanceof Error) {
      const staged = error as StagedError;
      staged.stage = staged.stage || currentStage;
      throw staged;
    }
    throw new StageError(String(error), currentStage || 'pipeline');
  } finally {
    try {
      if (audioPath) fs.rmSync(audioPath, { force: true });
    } catch {}
    try {
      if (wavPath) fs.rmSync(wavPath, { force: true });
    } catch {}
  }
}

export function friendlyError(error: unknown): string {
  if (error instanceof StageError) {
    const detail = error.details ? ` ${error.details.slice(-600)}` : '';
    if (error.stage === 'downloading')
      return `YouTube could not provide this video. Check that it is public and the URL is correct.${detail}`;
    if (error.stage === 'transcribing' && error.message.includes('model is missing')) return error.message;
    if (error.stage === 'summarizing' && /credential|auth|api key|401|403/i.test(`${error.message} ${detail}`))
      return 'The summarizer could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.';
    return `${error.message}${detail}`;
  }
  if (error instanceof Error && error.message) return error.message;
  if (error instanceof Error) return 'The worker stopped unexpectedly.';
  return typeof error === 'string' && error ? error : 'The worker stopped unexpectedly.';
}
