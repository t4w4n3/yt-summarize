/**
 * Integration test for GET /api/jobs (history) against the real app server
 * (src/infrastructure/inbound/http.ts) on an ephemeral port + a seeded temp
 * SQLite DB. No worker runs here: jobs are seeded straight to done/failed.
 *
 * The history list is bounded and metadata-only: done jobs newest first,
 * no markdown payload, ?limit= clamped by validation (400 outside 1..50),
 * ?q= searches titles (case-insensitive, max 100 chars).
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-history-data-'));
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-history-art-'));
process.env.DATA_DIR = dataDir;
process.env.ARTIFACTS_DIR = artifactsDir;

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const FAILED_ID = '33333333-3333-4333-8333-333333333333';

const dbMod = await import('../../src/infrastructure/outbound/sqlite/job-store.ts');

let port = 0;
let base = '';
let child: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/jobs/nonexistent`);
      if (res.status === 404) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not come up at ${base}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  const db = dbMod.openDatabase();
  dbMod.createJob(db, OLD_ID, 'https://youtu.be/AAAAAAAAAAA', 'AAAAAAAAAAA', 'en');
  dbMod.createJob(db, NEW_ID, 'https://youtu.be/BBBBBBBBBBB', 'BBBBBBBBBBB', 'fr');
  dbMod.createJob(db, FAILED_ID, 'https://youtu.be/CCCCCCCCCCC', 'CCCCCCCCCCC', 'en');
  // claimNextJob takes the oldest first: OLD, NEW, FAILED.
  dbMod.claimNextJob(db);
  dbMod.markDone(db, OLD_ID, 'Alpha zoo', '## secret markdown body');
  dbMod.claimNextJob(db);
  dbMod.markDone(db, NEW_ID, 'Beta cooking', '## secret markdown body');
  dbMod.claimNextJob(db);
  dbMod.markFailed(db, FAILED_ID, 'boom', 'summarizing');
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', OLD_ID);
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', NEW_ID);
  dbMod.closeDatabase(db);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn('node', ['src/infrastructure/inbound/http.ts'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ARTIFACTS_DIR: artifactsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
  await waitForServer();
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child?.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

describe('server — GET /api/jobs (history)', () => {
  it('lists done jobs newest first, without markdown', async () => {
    const res = await fetch(`${base}/api/jobs`);
    assert.equal(res.status, 200, `GET /api/jobs must be 200, got ${res.status}`);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.jobs.map((j) => j.jobId),
      [NEW_ID, OLD_ID],
      `jobs must be done-only, newest first, got ${JSON.stringify(body.jobs.map((j) => j.jobId))}`,
    );
    for (const job of body.jobs) {
      assert.equal(job.status, 'done', `history entry ${String(job.jobId)} must be done`);
      assert.equal('markdown' in job, false, 'history entries must not carry the markdown body');
    }
    assert.equal(body.jobs[0]?.title, 'Beta cooking');
    assert.equal(body.jobs[0]?.lang, 'fr');
    assert.equal(body.jobs[1]?.lang, 'en');
  });

  it('filters by ?q= case-insensitively on the title', async () => {
    const res = await fetch(`${base}/api/jobs?q=ALPHA`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.jobs.map((j) => j.jobId),
      [OLD_ID],
      'q=ALPHA must match only "Alpha zoo"',
    );
  });

  it('honours ?limit= and rejects out-of-range limits with 400', async () => {
    const fifty = await fetch(`${base}/api/jobs?limit=50`);
    assert.equal(fifty.status, 200, 'limit=50 (the max) must be accepted');
    const fiftyBody = (await fifty.json()) as { jobs: unknown[] };
    assert.equal(fiftyBody.jobs.length, 2, 'limit=50 must return both done jobs');

    const one = await fetch(`${base}/api/jobs?limit=1`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { jobs: unknown[] };
    assert.equal(oneBody.jobs.length, 1, 'limit=1 must return exactly one job');

    for (const bad of ['0', '51', 'abc', '1.5', '-1']) {
      const res = await fetch(`${base}/api/jobs?limit=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `limit=${bad} must be 400, got ${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'The limit must be an integer between 1 and 50.', `limit=${bad} error text`);
    }
  });

  it('accepts a search query of exactly 100 characters', async () => {
    const res = await fetch(`${base}/api/jobs?q=${'x'.repeat(100)}`);
    assert.equal(res.status, 200, `100-char q must be accepted, got ${res.status}`);
    const body = (await res.json()) as { jobs: unknown[] };
    assert.deepEqual(body.jobs, [], 'a 100-char query matching no title must return an empty list');
  });

  it('rejects a search query longer than 100 characters with 400', async () => {
    const res = await fetch(`${base}/api/jobs?q=${'x'.repeat(101)}`);
    assert.equal(res.status, 400, `101-char q must be 400, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'The search query must be 100 characters or fewer.');
  });
});
