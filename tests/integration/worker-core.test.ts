/**
 * Integration tests for the worker polling loop (src/worker/worker-core.ts).
 *
 * Drives createWorker() — the claim/reclaim/run/markDone/markFailed loop that
 * `worker.ts` bootstraps — against a real temporary SQLite DB with a fake
 * `runJob` and fake `sleep`, so neither real subprocesses nor real timers are
 * involved. Previously this logic lived in the untestable `worker.ts`
 * entrypoint (module-level DB open, infinite loop, process handlers) and sat
 * at 0% coverage.
 *
 * Category: integration — real adapter (SQLite) + faked orchestration inputs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { claimNextJob, createJob, markDone } from '../../src/shared/db.ts';
import { StageError } from '../../src/worker/stages/process.ts';
import { createWorker, runWithTimeout } from '../../src/worker/worker-core.ts';

const SCHEMA = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    stage TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    error TEXT,
    markdown TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    last_heartbeat_at TEXT,
    updated_at TEXT NOT NULL,
    video_id TEXT,
    lang TEXT
  );
`;

let dir: string | undefined;
let db: DatabaseSync | undefined;

function freshDb(): DatabaseSync {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  const d = new DatabaseSync(path.join(dir, 'jobs.db'));
  d.exec(SCHEMA);
  db = d;
  return d;
}

afterEach(() => {
  if (db !== undefined) {
    try {
      db.close();
    } catch {}
  }
  if (dir !== undefined) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  db = undefined;
  dir = undefined;
});

/** sleep that resolves on the next microtask — no real timer wait. */
const instantSleep = () => Promise.resolve();

describe('worker-core — polling loop', () => {
  it('runOnce returns false and sleeps when nothing is queued', async () => {
    const d = freshDb();
    let slept = 0;
    const w = createWorker({
      db: d,
      pollMs: 1500,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: () => {
        slept++;
        return Promise.resolve();
      },
    });
    const worked = await w.runOnce();
    assert.equal(worked, false);
    assert.equal(slept, 1); // waited a poll interval
    assert.equal(claimNextJob(d), null); // nothing running now
  });

  it('runOnce claims and runs a queued job to completion', async () => {
    const d = freshDb();
    createJob(d, 'ok', 'https://youtu.be/OKOKOKOKOKO');
    let ran: string | undefined;
    const w = createWorker({
      db: d,
      pollMs: 1000,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
      runJob: async (db, job) => {
        ran = job.id;
        markDone(db, job.id, 'T', '# done');
      },
    });
    const worked = await w.runOnce();
    assert.equal(worked, true);
    assert.equal(ran, 'ok');
    // job finished → not re-queued / claimed again
    assert.equal(claimNextJob(d), null);
  });

  it('runOnce marks a failed job with friendly error and StageError stage attribution', async () => {
    const d = freshDb();
    createJob(d, 'bad', 'https://youtu.be/BADBADBADBA');
    const w = createWorker({
      db: d,
      pollMs: 1000,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
      runJob: async () => {
        throw new StageError('youtube refused', 'downloading', 'yt-dlp: No video');
      },
    });
    await w.runOnce();
    const row = d.prepare('SELECT status, error, stage FROM jobs WHERE id = ?').get('bad') as {
      status: string;
      error: string;
      stage: string | null;
    };
    assert.equal(row.status, 'failed');
    // friendlyError maps downloading failures to a user-facing message
    assert.match(row.error, /YouTube could not provide this video/i);
    assert.equal(row.stage, 'downloading');
  });

  it('runOnce attributes a plain error to a null stage (no StageError)', async () => {
    const d = freshDb();
    createJob(d, 'plain', 'https://youtu.be/PLAINPLAINPL');
    const w = createWorker({
      db: d,
      pollMs: 1000,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
      runJob: async () => {
        throw new Error('youtube refused');
      },
    });
    await w.runOnce();
    const row = d.prepare('SELECT status, error, stage FROM jobs WHERE id = ?').get('plain') as {
      status: string;
      error: string;
      stage: string | null;
    };
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'youtube refused');
    assert.equal(row.stage, null);
  });

  it('runOnce reclaims + re-runs a stale running job in the same tick', async () => {
    const d = freshDb();
    createJob(d, 'stale', 'https://youtu.be/STALESTALEST');
    claimNextJob(d); // now running
    // backdate heartbeat beyond staleAfterMs (60s)
    d.prepare('UPDATE jobs SET last_heartbeat_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      'stale',
    );
    let runs = 0;
    const w = createWorker({
      db: d,
      pollMs: 1000,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
      runJob: async (db, job) => {
        runs++;
        markDone(db, job.id, 't', 'md');
      },
    });
    await w.runOnce();
    assert.equal(runs, 1);
    const row = d.prepare('SELECT status FROM jobs WHERE id = ?').get('stale') as { status: string };
    assert.equal(row.status, 'done');
  });

  it('reclaims stale jobs but leaves fresh running jobs alone', async () => {
    const d = freshDb();
    createJob(d, 'fresh', 'https://youtu.be/FRESHFRESHFR');
    claimNextJob(d); // fresh, no jobs to run → returns false
    const w = createWorker({
      db: d,
      pollMs: 1000,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
    });
    const worked = await w.runOnce();
    assert.equal(worked, false);
    const row = d.prepare('SELECT status FROM jobs WHERE id = ?').get('fresh') as { status: string };
    assert.equal(row.status, 'running'); // not reclaimed
  });

  it('start() drives a loop and stop() terminates it', async () => {
    const d = freshDb();
    createJob(d, 'j', 'https://youtu.be/LOOPLOOPLOOP');
    let runs = 0;
    const w = createWorker({
      db: d,
      pollMs: 1,
      staleAfterMs: 60_000,
      jobTimeoutMs: 1_800_000,
      sleep: instantSleep,
      runJob: async (db, job) => {
        runs++;
        markDone(db, job.id, 't', 'md');
        w.stop(); // stop after the first job
      },
    });
    await w.start();
    assert.equal(runs, 1);
  });
});

describe('worker-core — runWithTimeout', () => {
  it('resolves when the task finishes before the timeout', async () => {
    const controller = new AbortController();
    const task = () => Promise.resolve();
    await runWithTimeout(task, 5000, controller);
    assert.equal(controller.signal.aborted, false);
  });

  it('rejects and aborts the controller when the task exceeds the timeout', async () => {
    const controller = new AbortController();
    const task = () =>
      new Promise<void>((resolve) => {
        // never resolves; runWithTimeout must time it out
        void resolve;
      });
    await assert.rejects(runWithTimeout(task, 1, controller), /minute limit/i);
    assert.equal(controller.signal.aborted, true);
  });
});
