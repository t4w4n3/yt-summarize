/**
 * Integration tests for the SQLite JobStore adapter (phase 2A).
 * Drives the port through a real temporary SQLite database and asserts
 * the domain Job view matches the shared-DB contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import type { Job } from '../../src/domain/job/entity.ts';
import { createSqliteJobStore } from '../../src/infrastructure/outbound/sqlite/job-store.ts';

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

function freshStore() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstore-'));
  const d = new DatabaseSync(path.join(dir, 'jobs.db'));
  d.exec(SCHEMA);
  db = d;
  return createSqliteJobStore(d);
}

function must(job: Job | null): Job {
  assert.ok(job, 'expected a job to exist');
  return job;
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

describe('JobStore (SQLite adapter)', () => {
  it('create → get round-trip with an explicit video id and language', () => {
    const store = freshStore();
    const created = must(
      store.create({ id: 'j1', url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', lang: 'fr' }),
    );
    assert.equal(created.status, 'queued');
    assert.equal(created.progress, 0);
    assert.equal(created.videoId, 'dQw4w9WgXcQ');
    assert.equal(created.lang, 'fr');
    const fetched = must(store.get('j1'));
    assert.equal(fetched.id, 'j1');
    assert.equal(fetched.url, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(store.get('missing'), null);
  });

  it('create infers the video id from the URL and defaults language to null', () => {
    const store = freshStore();
    const job = must(store.create({ id: 'j2', url: 'https://youtu.be/A7w6PDdrWnA' }));
    assert.equal(job.videoId, 'A7w6PDdrWnA');
    assert.equal(job.lang, null);
  });

  it('findExisting prefers done over queued for the same video + language', () => {
    const store = freshStore();
    const first = must(
      store.create({ id: 'a', url: 'https://youtu.be/DUPDUPDUPDU', videoId: 'DUPDUPDUPDU', lang: 'en' }),
    );
    const claimed = must(store.claimNext());
    assert.equal(claimed.id, first.id);
    must(store.markDone(first.id, 'T', '# done'));
    const second = must(
      store.create({ id: 'b', url: 'https://youtu.be/DUPDUPDUPDU', videoId: 'DUPDUPDUPDU', lang: 'en' }),
    );
    assert.equal(second.id, 'b');
    const existing = must(store.findExisting('DUPDUPDUPDU', 'en'));
    assert.equal(existing.id, 'a');
    assert.equal(existing.status, 'done');
  });

  it('claim → stage → heartbeat → fail → retry lifecycle', () => {
    const store = freshStore();
    const queued = must(
      store.create({ id: 'life', url: 'https://youtu.be/LIFELIFELIFE', videoId: 'LIFELIFELIFE', lang: null }),
    );
    assert.equal(queued.status, 'queued');
    const claimed = must(store.claimNext());
    assert.equal(claimed.status, 'running');
    assert.ok(claimed.claimedAt);
    const staged = must(store.updateStage(claimed.id, 'downloading', 5));
    assert.equal(staged.stage, 'downloading');
    assert.equal(staged.progress, 5);
    const beat = must(store.heartbeat(claimed.id));
    assert.equal(beat.status, 'running');
    assert.ok(beat.lastHeartbeatAt);
    const failed = must(store.markFailed(claimed.id, 'boom', 'downloading'));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'boom');
    const retried = must(store.retryFailed(claimed.id));
    assert.equal(retried.status, 'queued');
    assert.equal(retried.error, null);
    assert.equal(retried.progress, 0);
  });

  it('reclaimStaleJobs re-queues only stale running jobs', () => {
    const store = freshStore();
    const stale = must(store.create({ id: 'stale', url: 'https://youtu.be/STALESTALEST', videoId: 'STALESTALEST' }));
    const claimed = must(store.claimNext());
    assert.equal(claimed.id, stale.id);
    assert.ok(db);
    db.prepare('UPDATE jobs SET last_heartbeat_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      stale.id,
    );
    assert.equal(store.reclaimStaleJobs(60_000), 1);
    const after = must(store.get(stale.id));
    assert.equal(after.status, 'queued');
    assert.equal(after.claimedAt, null);
  });
});
