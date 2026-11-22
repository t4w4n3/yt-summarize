/**
 * Filesystem ArtifactStore adapter (phase 2A).
 * Owns the on-disk conventions moved out of `worker/pipeline.ts`; the
 * bounded probes (≤4 KiB transcript sniff, 12-byte WAV header) are
 * preserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactPaths, ArtifactProbeResult, ArtifactStore } from '../application/ports/artifact-store.ts';
import { decideResumePoint } from '../application/resume-policy.ts';

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

function rmQuietly(file: string | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

export function createFilesystemArtifactStore(artifactsDir: string): ArtifactStore {
  function pathsFor(jobId: string): ArtifactPaths {
    const jobDir = path.join(artifactsDir, jobId);
    return {
      jobDir,
      logPath: path.join(jobDir, 'stage.log'),
      transcriptPath: path.join(jobDir, 'transcript.txt'),
      wavPath: path.join(jobDir, 'audio.wav'),
      summaryPath: path.join(jobDir, 'summary.md'),
    };
  }

  function probe(jobId: string): ArtifactProbeResult {
    const paths = pathsFor(jobId);
    const hasTranscript = hasTextContent(paths.transcriptPath);
    const hasWav = !hasTranscript && isValidWav(paths.wavPath);
    const downloadedAudioPath = hasTranscript || hasWav ? undefined : findDownloadedAudio(paths.jobDir);
    const hasDownloadedAudio = downloadedAudioPath !== undefined;
    return {
      ...paths,
      downloadedAudioPath: downloadedAudioPath ?? null,
      hasTranscript,
      hasWav,
      hasDownloadedAudio,
      resume: decideResumePoint({ hasTranscript, hasWav, hasDownloadedAudio }),
    };
  }

  return {
    ensureJobDir(jobId: string): string {
      const dir = pathsFor(jobId).jobDir;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    pathsFor,
    probe,
    readCachedTitle(jobId: string): string | undefined {
      try {
        const title = fs
          .readFileSync(path.join(pathsFor(jobId).jobDir, '.title'), 'utf8')
          .trim()
          .split(/\r?\n/)
          .at(-1)
          ?.trim();
        return title ? title.slice(0, 500) : undefined;
      } catch {
        return undefined;
      }
    },
    writeSummary(jobId: string, markdown: string): string {
      const summaryPath = pathsFor(jobId).summaryPath;
      fs.writeFileSync(summaryPath, `${markdown}\n`, 'utf8');
      return summaryPath;
    },
    removeDownloadedAudio(jobId: string): void {
      let names: string[];
      try {
        names = fs.readdirSync(pathsFor(jobId).jobDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith('audio.') && name !== 'audio.wav') rmQuietly(path.join(pathsFor(jobId).jobDir, name));
      }
    },
    removeTitle(jobId: string): void {
      rmQuietly(path.join(pathsFor(jobId).jobDir, '.title'));
    },
    removeFile(filePath: string | undefined): void {
      rmQuietly(filePath);
    },
    removeWav(jobId: string): void {
      rmQuietly(pathsFor(jobId).wavPath);
    },
  };
}
