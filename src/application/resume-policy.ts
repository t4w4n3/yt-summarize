/**
 * Artifact-resume policy owned by the application layer (phase 1E).
 * Pure decision: the furthest valid artifact on disk wins. The fs probes
 * that produce these booleans stay in the pipeline adapter until phase 2
 * (ArtifactStore port).
 */
export interface ArtifactProbe {
  readonly hasTranscript: boolean;
  readonly hasWav: boolean;
  readonly hasDownloadedAudio: boolean;
}

export type ResumePoint = 'summarizing' | 'transcribing' | 'converting' | null;

export function decideResumePoint(probe: ArtifactProbe): ResumePoint {
  if (probe.hasTranscript) return 'summarizing';
  if (probe.hasWav) return 'transcribing';
  if (probe.hasDownloadedAudio) return 'converting';
  return null;
}
