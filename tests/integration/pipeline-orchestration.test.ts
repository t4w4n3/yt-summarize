/**
 * Integration tests for the pipeline orchestrator (src/worker/pipeline.ts).
 *
 * Drives runPipeline() — the download→convert→transcribe→summarize chain —
 * with injected fake stage functions, so no real subprocesses or HTTP calls
 * are involved. Verifies stage ordering, stage/progress updates, markDone,
 * per-stage failure attribution (StageError / plain Error / non-Error), and
 * temporary-file cleanup in `finally`.
 *
 * The stage functions are resolved from config at import time, so DATA_DIR /
 * ARTIFACTS_DIR are pinned to temp dirs *before* the module is loaded (via
 * dynamic import) — otherwise config.artifactsDir would stay at its default.
 *
 * Category: integration — real SQLite + faked outbound stages.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-data-'));
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-art-'));
// Pin config *before* any module that reads it is loaded.
process.env.DATA_DIR = dataDir;
process.env.ARTIFACTS_DIR = artifactsDir;

const dbMod = await import('../../src/shared/db.ts');
const { config } = await import('../../src/shared/config.ts');
const pipelineMod = await import('../../src/worker/pipeline.ts');
const { StageError } = await import('../../src/worker/stages/process.ts');

type Stages = NonNullable<Parameters<typeof pipelineMod.runPipeline>[3]>;

/** Minimal shape we assert on for StagedError / plain attributes. */
interface Staged {
  stage?: string | null;
  message?: string;
}

let db: DatabaseSync | undefined;

function freshDb(): DatabaseSync {
  const d = dbMod.openDatabase() as DatabaseSync;
  db = d;
  return d;
}

afterEach(() => {
  if (db !== undefined) {
    try {
      db.close();
    } catch {}
  }
  db = undefined;
});

function makeJob(db: DatabaseSync, id: string, lang: string | null) {
  dbMod.createJob(db, id, 'https://youtu.be/XXXXXXXXXXX', undefined, lang);
  const claimed = dbMod.claimNextJob(db);
  assert.ok(claimed);
  const row = dbMod.getJob(db, claimed.id);
  assert.ok(row);
  return row;
}

interface FakeStages extends Stages {
  calls: string[];
  langs: string[];
  /** Files the fakes "produced", for cleanup assertions. */
  files: string[];
}

function jobDir(jobId: string): string {
  return path.join(config.artifactsDir, jobId);
}

function makeFakes(): FakeStages {
  const files: string[] = [];
  const fakes: FakeStages = {
    calls: [],
    langs: [],
    files,
    downloader: {
      download: async (input) => {
        fakes.calls.push('download');
        const p = path.join(input.jobDir, 'audio.m4a');
        files.push(p);
        fs.writeFileSync(p, 'audio');
        return { audioPath: p, title: 'Test title' };
      },
    },
    converter: {
      convert: async (input) => {
        fakes.calls.push('convert');
        const p = path.join(input.jobDir, 'audio.wav');
        files.push(p);
        fs.writeFileSync(p, 'wav');
        return p;
      },
    },
    transcriber: {
      transcribe: async (input) => {
        fakes.calls.push('transcribe');
        return path.join(input.jobDir, 'transcript.txt');
      },
    },
    summarizer: {
      summarize: async (input) => {
        fakes.calls.push('summarize');
        fakes.langs.push(input.lang ?? '');
        return '# Summary';
      },
    },
  };
  return fakes;
}

describe('pipeline — orchestration (injected fakes)', () => {
  it('runs all four stages in order and completes the job', async () => {
    db = freshDb();
    const job = makeJob(db, 'happy', null);
    const fakes = makeFakes();
    const audio = path.join(jobDir('happy'), 'audio.m4a');

    await pipelineMod.runPipeline(db, job, new AbortController().signal, fakes);

    assert.deepEqual(fakes.calls, ['download', 'convert', 'transcribe', 'summarize']);
    const row = dbMod.getJob(db, 'happy');
    assert.ok(row);
    assert.equal(row.status, 'done');
    assert.equal(row.title, 'Test title');
    assert.equal(row.markdown, '# Summary');
    assert.equal(row.stage, null);
    // summary.md written
    assert.ok(fs.existsSync(path.join(jobDir('happy'), 'summary.md')));
    // temporary audio/wav cleaned up
    assert.ok(!fs.existsSync(audio));
  });

  it('fills the current stage into a StageError that lacks one', async () => {
    db = freshDb();
    const job = makeJob(db, 'stg', null);
    const fakes = makeFakes();
    fakes.downloader.download = async () => {
      throw new StageError('boom', '');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes), (err: unknown) => {
      assert.ok(err instanceof StageError);
      assert.equal((err as Staged).stage, 'downloading');
      return true;
    });
  });

  it('preserves an explicit stage on a StageError from a later stage', async () => {
    db = freshDb();
    const job = makeJob(db, 'keep', null);
    const fakes = makeFakes();
    fakes.summarizer.summarize = async () => {
      throw new StageError('llm down', 'summarizing');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes), (err: unknown) => {
      assert.ok(err instanceof StageError);
      assert.equal((err as Staged).stage, 'summarizing');
      return true;
    });
  });

  it('attributes a plain Error to the current stage', async () => {
    db = freshDb();
    const job = makeJob(db, 'plain', null);
    const fakes = makeFakes();
    fakes.converter.convert = async () => {
      throw new Error('ffmpeg broke');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes), (err: unknown) => {
      assert.equal((err as Staged).message, 'ffmpeg broke');
      assert.equal((err as Staged).stage, 'converting');
      return true;
    });
  });

  it('wraps a non-Error rejection in a StageError with the current stage', async () => {
    db = freshDb();
    const job = makeJob(db, 'nonerr', null);
    const fakes = makeFakes();
    fakes.transcriber.transcribe = async () => {
      throw 'unexpected string';
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes), (err: unknown) => {
      assert.ok(err instanceof StageError);
      assert.equal((err as Staged).message, 'unexpected string');
      assert.equal((err as Staged).stage, 'transcribing');
      return true;
    });
  });

  it('keeps the downloaded audio in finally when convert fails (retry resumes from it)', async () => {
    db = freshDb();
    const job = makeJob(db, 'clean', null);
    const fakes = makeFakes();
    const producedAudio = path.join(jobDir('clean'), 'audio.m4a');
    fakes.converter.convert = async () => {
      throw new Error('explode');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes));
    // Intentional change for retry: completed-stage artifacts survive a
    // failure so a retry does not pay for them again; only the failed
    // stage's partial output is dropped (see 'keep-audio' case above).
    assert.ok(fs.existsSync(producedAudio), 'downloaded audio must survive a convert failure for retry resume');
  });

  it('resume: existing transcript.txt skips download/convert/transcribe and reuses the .title', async () => {
    db = freshDb();
    const job = makeJob(db, 'resume-t', null);
    fs.mkdirSync(jobDir('resume-t'), { recursive: true });
    fs.writeFileSync(path.join(jobDir('resume-t'), 'transcript.txt'), 'already transcribed text');
    fs.writeFileSync(path.join(jobDir('resume-t'), '.title'), 'Cached title');
    const fakes = makeFakes();
    await pipelineMod.runPipeline(db, job, new AbortController().signal, fakes);
    assert.deepEqual(fakes.calls, ['summarize'], `calls ${fakes.calls} must skip paid stages when transcript exists`);
    const row = dbMod.getJob(db, 'resume-t');
    assert.equal(row?.status, 'done');
    assert.equal(row?.title, 'Cached title', `title ${row?.title} must come from the cached .title file`);
  });

  it('resume: existing valid audio.wav skips download/convert only', async () => {
    db = freshDb();
    const job = makeJob(db, 'resume-w', null);
    fs.mkdirSync(jobDir('resume-w'), { recursive: true });
    const wav = Buffer.alloc(100);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    fs.writeFileSync(path.join(jobDir('resume-w'), 'audio.wav'), wav);
    fs.writeFileSync(path.join(jobDir('resume-w'), '.title'), 'Wav title');
    const fakes = makeFakes();
    await pipelineMod.runPipeline(db, job, new AbortController().signal, fakes);
    assert.deepEqual(fakes.calls, ['transcribe', 'summarize'], `calls ${fakes.calls} must resume from audio.wav`);
    assert.equal(dbMod.getJob(db, 'resume-w')?.title, 'Wav title');
  });

  it('resume: existing downloaded audio skips download only', async () => {
    db = freshDb();
    const job = makeJob(db, 'resume-a', null);
    fs.mkdirSync(jobDir('resume-a'), { recursive: true });
    fs.writeFileSync(path.join(jobDir('resume-a'), 'audio.m4a'), 'audio');
    fs.writeFileSync(path.join(jobDir('resume-a'), '.title'), 'Audio title');
    const fakes = makeFakes();
    await pipelineMod.runPipeline(db, job, new AbortController().signal, fakes);
    assert.deepEqual(
      fakes.calls,
      ['convert', 'transcribe', 'summarize'],
      `calls ${fakes.calls} must resume from audio.m4a`,
    );
    assert.equal(dbMod.getJob(db, 'resume-a')?.title, 'Audio title');
  });

  it('resume: empty/invalid artifacts are not reused — all stages run', async () => {
    db = freshDb();
    const job = makeJob(db, 'resume-x', null);
    fs.mkdirSync(jobDir('resume-x'), { recursive: true });
    fs.writeFileSync(path.join(jobDir('resume-x'), 'transcript.txt'), '   \n');
    fs.writeFileSync(path.join(jobDir('resume-x'), 'audio.wav'), 'RIFF');
    fs.writeFileSync(path.join(jobDir('resume-x'), 'audio.m4a'), '');
    const fakes = makeFakes();
    await pipelineMod.runPipeline(db, job, new AbortController().signal, fakes);
    assert.deepEqual(
      fakes.calls,
      ['download', 'convert', 'transcribe', 'summarize'],
      `calls ${fakes.calls} must not reuse empty/invalid artifacts`,
    );
  });

  it('failure: convert failure keeps downloaded audio but removes the partial wav for retry', async () => {
    db = freshDb();
    const job = makeJob(db, 'keep-audio', null);
    const fakes = makeFakes();
    fakes.converter.convert = async (input) => {
      fs.writeFileSync(path.join(jobDir('keep-audio'), 'audio.wav'), 'partial');
      void input;
      throw new Error('ffmpeg broke');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes));
    assert.ok(
      fs.existsSync(path.join(jobDir('keep-audio'), 'audio.m4a')),
      'downloaded audio.m4a must survive a convert failure so retry skips re-download',
    );
    assert.ok(
      !fs.existsSync(path.join(jobDir('keep-audio'), 'audio.wav')),
      'partial audio.wav must be removed after a convert failure',
    );
  });

  it('failure: download failure removes the partial audio so retry re-downloads', async () => {
    db = freshDb();
    const job = makeJob(db, 'drop-partial', null);
    const fakes = makeFakes();
    fakes.downloader.download = async () => {
      fs.writeFileSync(path.join(jobDir('drop-partial'), 'audio.m4a'), 'partial');
      throw new StageError('yt-dlp failed', 'downloading');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes));
    assert.ok(
      !fs.existsSync(path.join(jobDir('drop-partial'), 'audio.m4a')),
      'partial audio.m4a must be removed after a download failure',
    );
  });

  it('failure: summarize failure keeps transcript.txt for retry', async () => {
    db = freshDb();
    const job = makeJob(db, 'keep-t', null);
    const fakes = makeFakes();
    fakes.transcriber.transcribe = async () => {
      const p = path.join(jobDir('keep-t'), 'transcript.txt');
      fs.writeFileSync(p, 'transcribed');
      return p;
    };
    fakes.summarizer.summarize = async () => {
      throw new StageError('llm down', 'summarizing');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes));
    assert.ok(
      fs.existsSync(path.join(jobDir('keep-t'), 'transcript.txt')),
      'transcript.txt must survive a summarize failure so retry skips STT',
    );
    assert.ok(!fs.existsSync(path.join(jobDir('keep-t'), 'audio.wav')), 'audio.wav must be cleaned after transcribe');
  });

  it('passes job.lang through to summarize (and defaults NULL to en)', async () => {
    db = freshDb();
    const fr = makeJob(db, 'fr', 'fr');
    const f1 = makeFakes();
    await pipelineMod.runPipeline(db, fr, new AbortController().signal, f1);
    assert.deepEqual(f1.langs, ['fr']);

    const en = makeJob(db, 'en', null);
    const f2 = makeFakes();
    await pipelineMod.runPipeline(db, en, new AbortController().signal, f2);
    assert.deepEqual(f2.langs, ['en']);
  });
});
