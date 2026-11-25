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

  it('listDone returns only done jobs, newest first, bounded by limit', () => {
    const store = freshStore();
    for (const id of ['old', 'mid', 'new']) {
      const job = must(store.create({ id, url: 'https://youtu.be/AAAAAAAAAAA', videoId: id, lang: 'en' }));
      must(store.claimNext());
      must(store.markDone(job.id, `Title ${id}`, '# note'));
    }
    const pending = must(store.create({ id: 'pending', url: 'https://youtu.be/BBBBBBBBBBB', videoId: 'pending' }));
    assert.equal(pending.status, 'queued');
    assert.ok(db);
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'old');
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', 'mid');
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2026-03-01T00:00:00.000Z', 'new');
    assert.deepEqual(
      store.listDone(10).map((j) => j.id),
      ['new', 'mid', 'old'],
      'listDone(10) must return done jobs newest-first and skip the queued one',
    );
    assert.deepEqual(
      store.listDone(2).map((j) => j.id),
      ['new', 'mid'],
      'listDone(2) must return at most 2 jobs',
    );
  });

  it('listDone search filters titles case-insensitively and literally', () => {
    const store = freshStore();
    const a = must(store.create({ id: 'alpha', url: 'https://youtu.be/CCCCCCCCCCC', videoId: 'alpha' }));
    must(store.claimNext());
    must(store.markDone(a.id, 'Alpha 100%_Guide', '# note'));
    const b = must(store.create({ id: 'beta', url: 'https://youtu.be/DDDDDDDDDDD', videoId: 'beta' }));
    must(store.claimNext());
    must(store.markDone(b.id, 'Beta notes', '# note'));
    const c = must(store.create({ id: 'gamma', url: 'https://youtu.be/EEEEEEEEEEE', videoId: 'gamma' }));
    must(store.claimNext());
    must(store.markDone(c.id, 'Gamma 100XGuide', '# note'));
    assert.deepEqual(
      store.listDone(10, 'alpha').map((j) => j.id),
      ['alpha'],
      'search alpha must match Alpha 100%_Guide case-insensitively',
    );
    assert.deepEqual(
      store.listDone(10, '100%_').map((j) => j.id),
      ['alpha'],
      'search 100%_ must match literally, not as LIKE wildcards',
    );
    assert.deepEqual(
      store.listDone(10, 'delta').map((j) => j.id),
      [],
      'search delta must match nothing',
    );
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
