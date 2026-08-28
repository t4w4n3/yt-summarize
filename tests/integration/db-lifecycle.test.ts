/**
 * Integration tests for the shared SQLite job model (src/shared/db.ts).
 *
 * Drives the app↔worker shared-DB contract against a real temporary SQLite
 * database: job lifecycle (create→claim→heartbeat→done/failed), stale reclaim,
 * per-round dedup scoping and stage/progress updates. These functions are the
 * state machine both processes rely on — a regression here corrupts the queue.
 *
 * Category: integration — real adapter (SQLite via node:sqlite, temp file).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import {
  claimNextJob,
  closeDatabase,
  createJob,
  extractVideoIdFromUrl,
  findExistingJobByVideoId,
  getJob,
  heartbeat,
  markDone,
  markFailed,
  reclaimStaleJobs,
  updateStage,
} from '../../src/shared/db.ts';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
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

describe('shared db — job lifecycle state machine', () => {
  it('extractVideoIdFromUrl handles canonical and short forms + trims', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('  https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3 '), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('not a url'), null);
    assert.equal(extractVideoIdFromUrl('https://youtu.be/tooshort'), null);
  });

  it('createJob inserts queued + backfills video_id from legacy url', () => {
    const d = freshDb();
    const created = createJob(d, 'j1', 'https://youtu.be/dQw4w9WgXcQ');
    assert.ok(created);
    assert.equal(created.id, 'j1');
    assert.equal(created.status, 'queued');
    assert.equal(created.video_id, 'dQw4w9WgXcQ');

    const fromDb = getJob(d, 'j1');
    assert.equal(fromDb?.video_id, 'dQw4w9WgXcQ');
    assert.equal(fromDb?.lang, null);
  });

  it('createJob honours an explicit lang and explicit video id', () => {
    const d = freshDb();
    const created = createJob(d, 'j2', 'https://example.invalid/watch?v=abc', 'forced-id', 'fr');
    assert.equal(created?.video_id, 'forced-id');
    assert.equal(created?.lang, 'fr');
    assert.equal(getJob(d, 'j2')?.lang, 'fr');
  });

  it('claimNextJob claims the oldest queued job in FIFO order and returns running', () => {
    const d = freshDb();
    createJob(d, 'a', 'https://youtu.be/AAAAAAAAAAA');
    createJob(d, 'b', 'https://youtu.be/BBBBBBBBBBB');
    createJob(d, 'c', 'https://youtu.be/CCCCCCCCCCC');

    const claim1 = claimNextJob(d);
    assert.equal(claim1?.id, 'a');
    assert.equal(claim1?.status, 'running');
    assert.ok(claim1?.claimed_at);

    const claim2 = claimNextJob(d);
    assert.equal(claim2?.id, 'b');
  });

  it('claimNextJob returns null when nothing is queued', () => {
    const d = freshDb();
    assert.equal(claimNextJob(d), null);
  });

  it('updateStage sets stage + progress on a running job', () => {
    const d = freshDb();
    createJob(d, 's', 'https://youtu.be/SSSSSSSSSSS');
    claimNextJob(d);
    updateStage(d, 's', 'converting', 25);
    const row = getJob(d, 's');
    assert.equal(row?.stage, 'converting');
    assert.equal(row?.progress, 25);
  });

  it('heartbeat refreshes last_heartbeat_at', () => {
    const d = freshDb();
    createJob(d, 'h', 'https://youtu.be/HHHHHHHHHHH');
    claimNextJob(d);
    const before = getJob(d, 'h')?.last_heartbeat_at;
    heartbeat(d, 'h');
    const after = getJob(d, 'h')?.last_heartbeat_at;
    assert.ok(before && after && after <= new Date().toISOString());
  });

  it('markDone completes the job with title + markdown and clears error', () => {
    const d = freshDb();
    createJob(d, 'dn', 'https://youtu.be/DNDNDNDNDND');
    claimNextJob(d);
    markDone(d, 'dn', 'My title', '# Summary');
    const row = getJob(d, 'dn');
    assert.equal(row?.status, 'done');
    assert.equal(row?.progress, 100);
    assert.equal(row?.title, 'My title');
    assert.equal(row?.markdown, '# Summary');
    assert.equal(row?.stage, null);
  });

  it('markFailed records error, null stage and failed status', () => {
    const d = freshDb();
    createJob(d, 'fl', 'https://youtu.be/FLFLFLFLFLF');
    claimNextJob(d);
    markFailed(d, 'fl', 'boom', 'transcribing');
    const row = getJob(d, 'fl');
    assert.equal(row?.status, 'failed');
    assert.equal(row?.error, 'boom');
    assert.equal(row?.stage, 'transcribing');
  });

  it('reclaimStaleJobs re-queues a running job whose lease expired', () => {
    const d = freshDb();
    createJob(d, 'st', 'https://youtu.be/STSTSTSTSTS');
    claimNextJob(d);
    // Backdate the heartbeat so it is stale relative to the cutoff.
    d.prepare('UPDATE jobs SET last_heartbeat_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      'st',
    );
    const n = reclaimStaleJobs(d, 60_000);
    assert.equal(n, 1);
    const row = getJob(d, 'st');
    assert.equal(row?.status, 'queued');
    assert.equal(row?.stage, null);
    assert.equal(row?.error, null);
  });

  it('reclaimStaleJobs does not touch a job whose lease is fresh', () => {
    const d = freshDb();
    createJob(d, 'fr', 'https://youtu.be/FRFRFRFRFRF');
    claimNextJob(d);
    const n = reclaimStaleJobs(d, 60_000);
    assert.equal(n, 0);
    assert.equal(getJob(d, 'fr')?.status, 'running');
  });

  it('findExistingJobByVideoId dedups by video + lang across running/done jobs', () => {
    const d = freshDb();
    createJob(d, 'e1', 'https://youtu.be/E1E1E1E1E1E', 'vid123', 'en');
    createJob(d, 'e2', 'https://youtu.be/E2E2E2E2E2E2', 'vid123', 'fr');
    createJob(d, 'e3', 'https://youtu.be/E3E3E3E3E3', 'other', 'en');

    assert.equal(findExistingJobByVideoId(d, 'vid123', 'en')?.id, 'e1');
    assert.equal(findExistingJobByVideoId(d, 'vid123', 'fr')?.id, 'e2');
    // different video id → no match
    assert.equal(findExistingJobByVideoId(d, 'nonexistent', 'en'), null);
    // null video id → no match
    assert.equal(findExistingJobByVideoId(d, null, 'en'), null);
  });

  it('findExistingJobByVideoId prefers a done job over a queued one for the same video', () => {
    const d = freshDb();
    createJob(d, 'q', 'https://youtu.be/QQQQQQQQQQQ', 'vidp', 'en'); // queued
    createJob(d, 'dn2', 'https://youtu.be/DN2DN2DN2D2', 'vidp', 'en'); // queued
    const doneId = 'dn3';
    createJob(d, doneId, 'https://youtu.be/DN3DN3DN3DD', 'vidp', 'en');
    claimNextJob(d);
    claimNextJob(d);
    const claimed = claimNextJob(d);
    assert.equal(claimed?.id, doneId);
    markDone(d, doneId, 't', 'md');
    // done must be preferred over queued for the same video+lang
    const found = findExistingJobByVideoId(d, 'vidp', 'en');
    assert.equal(found?.id, doneId);
    // running still matches when no done exists for a different video
    const other = freshDb();
    createJob(other, 'r1', 'https://youtu.be/R1R1R1R1R1R', 'vidr', 'en');
    createJob(other, 'r2', 'https://youtu.be/R2R2R2R2R2R', 'vidr', 'en');
    claimNextJob(other);
    assert.equal(findExistingJobByVideoId(other, 'vidr', 'en')?.id, 'r1');
  });

  it('closeDatabase closes without throwing', () => {
    const d = freshDb();
    createJob(d, 'c1', 'https://youtu.be/CLOSECLOSECL');
    closeDatabase(d);
    db = undefined; // already closed — don't double-close in afterEach
  });
});
