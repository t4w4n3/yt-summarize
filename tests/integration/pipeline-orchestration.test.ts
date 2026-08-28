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
    async download(job) {
      fakes.calls.push('download');
      const j = job as { url: string; id: string };
      const p = path.join(jobDir(j.id), 'audio.m4a');
      files.push(p);
      fs.writeFileSync(p, 'audio');
      return { audioPath: p, title: 'Test title' };
    },
    async convert(audioPath) {
      fakes.calls.push('convert');
      const p = path.join(jobDir(path.basename(path.dirname(audioPath))), 'audio.wav');
      files.push(p);
      fs.writeFileSync(p, 'wav');
      return p;
    },
    async transcribe(wavPath) {
      fakes.calls.push('transcribe');
      return path.join(jobDir(path.basename(path.dirname(wavPath))), 'transcript.txt');
    },
    async summarize(_transcriptPath, ctx) {
      fakes.calls.push('summarize');
      fakes.langs.push(ctx.lang ?? '');
      return '# Summary';
    },
  };
  return fakes;
}

describe('pipeline — orchestration (injected fakes)', () => {
  it('runs all four stages in order and completes the job', async () => {
    db = freshDb();
    const job = makeJob(db, 'happy', null);
    const fakes = makeFakes();
    const audio = fakes.files[0] as string;

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
    fakes.download = async () => {
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
    fakes.summarize = async () => {
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
    fakes.convert = async () => {
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
    fakes.transcribe = async () => {
      throw 'unexpected string';
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes), (err: unknown) => {
      assert.ok(err instanceof StageError);
      assert.equal((err as Staged).message, 'unexpected string');
      assert.equal((err as Staged).stage, 'transcribing');
      return true;
    });
  });

  it('cleans up partial files in finally when a later stage fails', async () => {
    db = freshDb();
    const job = makeJob(db, 'clean', null);
    const fakes = makeFakes();
    const producedAudio = fakes.files[0] as string;
    fakes.convert = async () => {
      throw new Error('explode');
    };
    await assert.rejects(pipelineMod.runPipeline(db, job, new AbortController().signal, fakes));
    assert.ok(!fs.existsSync(producedAudio));
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
