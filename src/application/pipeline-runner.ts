import type { Job, Stage } from '../domain/job/entity.ts';
import { STAGES } from '../domain/job/entity.ts';
import type { RuntimeConfig } from './config.ts';
import { type StagedError, StageError } from './errors.ts';
import type { ArtifactStore } from './ports/artifact-store.ts';
import type { JobStore } from './ports/job-store.ts';
import type { PipelineStagePorts } from './ports/stage-ports.ts';
import { stageTimeoutMs } from './stage-timeouts.ts';

/**
 * The four outbound ports run in sequence. Injectable so tests can stub the
 * real subprocess/HTTP adapters; the worker composition root supplies the
 * real adapters.
 */
export type PipelineStages = PipelineStagePorts;

/** Dependencies injected into the application pipeline use case. */
export interface PipelineDependencies {
  jobStore: JobStore;
  artifactStore: ArtifactStore;
}

/**
 * Artifact resume (retry without paying again) is governed by the
 * ArtifactStore probe + resume policy: transcript > wav > downloaded audio.
 *
 * The runner is a pure use case: it only knows the JobStore, ArtifactStore
 * and stage ports it receives, so it can be driven with fakes in unit tests.
 */
export async function runPipeline(
  job: Job,
  dependencies: PipelineDependencies,
  signal: AbortSignal,
  stages: PipelineStages,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  const store = dependencies.jobStore;
  const artifacts = dependencies.artifactStore;
  const jobDir = artifacts.ensureJobDir(job.id);
  const logPath = artifacts.pathsFor(job.id).logPath;
  const onHeartbeat = () => store.heartbeat(job.id);
  const context = {
    jobDir,
    logPath,
    onHeartbeat,
    timeoutMs: stageTimeoutMs('downloading', runtimeConfig.jobTimeoutMs),
    signal,
  };
  let audioPath: string | undefined;
  let wavPath: string | undefined;
  let transcriptPath: string | undefined;
  let title: string | null = job.title ?? null;
  let currentStage: Stage | null = null;
  let succeeded = false;

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
        const downloaded = await stages.downloader.download({
          jobId: job.id,
          url: job.url,
          ...context,
          timeoutMs: stageTimeoutMs(currentStage, runtimeConfig.jobTimeoutMs),
        });
        audioPath = downloaded.audioPath;
        title = downloaded.title;
      }

      if (resume !== 'transcribing') {
        currentStage = STAGES[1];
        store.updateStage(job.id, currentStage, 25);
        wavPath = await stages.converter.convert({
          audioPath: audioPath as string,
          ...context,
          timeoutMs: stageTimeoutMs(currentStage, runtimeConfig.jobTimeoutMs),
        });
        artifacts.removeFile(audioPath);
        audioPath = undefined;
      }

      currentStage = STAGES[2];
      store.updateStage(job.id, currentStage, 45);
      transcriptPath = await stages.transcriber.transcribe({
        wavPath: wavPath as string,
        ...context,
        timeoutMs: stageTimeoutMs(currentStage, runtimeConfig.jobTimeoutMs),
      });
      artifacts.removeFile(audioPath);
      artifacts.removeFile(wavPath);
      audioPath = undefined;
      wavPath = undefined;
    }

    currentStage = STAGES[3];
    store.updateStage(job.id, currentStage, 70);
    // Legacy rows have a NULL lang column; NULL means English.
    const markdown = await stages.summarizer.summarize({
      transcriptPath: transcriptPath as string,
      ...context,
      timeoutMs: stageTimeoutMs(currentStage, runtimeConfig.jobTimeoutMs),
      lang: job.lang || 'en',
    });
    artifacts.writeSummary(job.id, markdown);
    store.markDone(job.id, title, markdown);
    succeeded = true;
  } catch (error) {
    // Attribute first, then drop only the failed stage's partial output so
    // completed-stage artifacts survive for a retry (see probe comment).
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
