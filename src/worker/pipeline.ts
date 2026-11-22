import type { DatabaseSync } from 'node:sqlite';
import { type StagedError, StageError } from '../application/errors.ts';
import { friendlyError, stageOf } from '../application/friendly-error.ts';
import type { Stage } from '../domain/job/entity.ts';
import { config } from '../shared/config.ts';
import type { JobRow } from '../shared/db.ts';
import { createSqliteJobStore } from '../shared/db.ts';
import { STAGES } from '../shared/job.ts';
import { stageTimeoutMs } from '../shared/timeouts.ts';
import { createFilesystemArtifactStore } from './artifacts.ts';
import { convert } from './stages/convert.ts';
import { download } from './stages/download.ts';
import { summarize } from './stages/summarize.ts';
import { transcribe } from './stages/transcribe.ts';

export type { StagedError };
// Canonical owners live in the application layer (phase 1D); re-exported so
// existing import paths (`worker/pipeline.ts`) keep working.
export { friendlyError, stageOf };

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

/**
 * Artifact resume (retry without paying again) is governed by the
 * ArtifactStore probe + resume policy: transcript > wav > downloaded audio.
 */
export async function runPipeline(
  db: DatabaseSync,
  job: JobRow,
  signal: AbortSignal,
  stages: PipelineStages = realStages,
): Promise<void> {
  const store = createSqliteJobStore(db);
  const artifacts = createFilesystemArtifactStore(config.artifactsDir);
  const jobDir = artifacts.ensureJobDir(job.id);
  const logPath = artifacts.pathsFor(job.id).logPath;
  const onHeartbeat = () => store.heartbeat(job.id);
  const context = { jobDir, logPath, onHeartbeat, timeoutMs: stageTimeoutMs('downloading'), signal };
  let audioPath: string | undefined;
  let wavPath: string | undefined;
  let transcriptPath: string | undefined;
  let title: string | null = job.title ?? null;
  let currentStage: Stage | null = null;
  let succeeded = false;

  // Resume probe: furthest valid artifact on disk wins (see helpers above).
  // The ArtifactStore probes feed the pure policy in application/resume-policy.
  const probe = artifacts.probe(job.id);
  const resume = probe.resume;
  if (resume !== null) {
    title = title || artifacts.readCachedTitle(job.id) || 'Untitled YouTube video';
  }
  if (resume === 'summarizing') transcriptPath = probe.transcriptPath;
  if (resume === 'transcribing') wavPath = probe.wavPath;
  if (resume === 'converting') audioPath = probe.downloadedAudioPath ?? undefined;

  try {
    if (resume !== 'summarizing') {
      if (resume === null) {
        currentStage = STAGES[0];
        store.updateStage(job.id, currentStage, 5);
        const downloaded = await stages.download(job, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
        audioPath = downloaded.audioPath;
        title = downloaded.title;
      }

      if (resume !== 'transcribing') {
        currentStage = STAGES[1];
        store.updateStage(job.id, currentStage, 25);
        wavPath = await stages.convert(audioPath as string, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
        // The wav now carries everything the download did; drop the raw
        // audio early so a later failure leaves at most one copy on disk.
        artifacts.removeFile(audioPath);
        audioPath = undefined;
      }

      currentStage = STAGES[2];
      store.updateStage(job.id, currentStage, 45);
      transcriptPath = await stages.transcribe(wavPath as string, {
        ...context,
        timeoutMs: stageTimeoutMs(currentStage),
      });
      artifacts.removeFile(audioPath);
      artifacts.removeFile(wavPath);
      audioPath = undefined;
      wavPath = undefined;
    }

    currentStage = STAGES[3];
    store.updateStage(job.id, currentStage, 70);
    // Legacy rows have a NULL lang column; NULL means English.
    const markdown = await stages.summarize(transcriptPath as string, {
      ...context,
      timeoutMs: stageTimeoutMs(currentStage),
      lang: job.lang || 'en',
    });
    artifacts.writeSummary(job.id, markdown);
    store.markDone(job.id, title, markdown);
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
      artifacts.removeDownloadedAudio(job.id);
      artifacts.removeTitle(job.id);
    } else if (failedStage === STAGES[1]) {
      artifacts.removeWav(job.id);
    }
    if (error instanceof StageError || error instanceof Error) throw error;
    throw new StageError(String(error), currentStage || 'pipeline');
  } finally {
    // On success the bulky intermediates go (transcript + summary stay).
    // On failure they stay put for the retry — see catch above.
    if (succeeded) {
      artifacts.removeDownloadedAudio(job.id);
      artifacts.removeFile(audioPath);
      artifacts.removeFile(wavPath);
      artifacts.removeWav(job.id);
    }
  }
}
