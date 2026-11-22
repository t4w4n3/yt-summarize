/**
 * Outbound port for stage artifacts on disk. The pipeline decides what
 * to do; the filesystem adapter owns the conventions and the probes.
 */
import type { ResumePoint } from '../resume-policy.ts';

export interface ArtifactPaths {
  readonly jobDir: string;
  readonly logPath: string;
  readonly transcriptPath: string;
  readonly wavPath: string;
  readonly summaryPath: string;
}

export interface ArtifactProbeResult extends ArtifactPaths {
  readonly downloadedAudioPath: string | null;
  readonly hasTranscript: boolean;
  readonly hasWav: boolean;
  readonly hasDownloadedAudio: boolean;
  readonly resume: ResumePoint;
}

export interface ArtifactStore {
  ensureJobDir(jobId: string): string;
  pathsFor(jobId: string): ArtifactPaths;
  probe(jobId: string): ArtifactProbeResult;
  readCachedTitle(jobId: string): string | undefined;
  writeSummary(jobId: string, markdown: string): string;
  removeDownloadedAudio(jobId: string): void;
  removeTitle(jobId: string): void;
  removeFile(filePath: string | undefined): void;
  removeWav(jobId: string): void;
}
