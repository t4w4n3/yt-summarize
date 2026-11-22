/**
 * Integration test for POST /api/jobs/:id/retry against the real app server
 * (src/infrastructure/inbound/http.ts) on an ephemeral port + a seeded temp SQLite DB.
 *
 * Seeded *before* the server starts: one failed job (retryable), one queued
 * and one done job (409), plus the unknown-id 404 case. No worker runs here,
 * so a retried job stays queued — the assertion is the HTTP contract, not
 * the pipeline (covered by pipeline-orchestration.test.ts).
 *
 * Category: integration — real HTTP + real SQLite, no paid stages.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-retry-data-'));
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-retry-art-'));
process.env.DATA_DIR = dataDir;
process.env.ARTIFACTS_DIR = artifactsDir;

const FAILED_ID = '11111111-1111-4111-8111-111111111111';
const QUEUED_ID = '22222222-2222-4222-8222-222222222222';
const DONE_ID = '33333333-3333-4333-8333-333333333333';

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
  dbMod.createJob(db, FAILED_ID, 'https://youtu.be/AAAAAAAAAAA');
  dbMod.createJob(db, QUEUED_ID, 'https://youtu.be/BBBBBBBBBBB');
  dbMod.createJob(db, DONE_ID, 'https://youtu.be/CCCCCCCCCCC');
  const claimedForFail = dbMod.claimNextJob(db); // FAILED_ID (oldest)
  assert.equal(claimedForFail?.id, FAILED_ID);
  dbMod.markFailed(db, FAILED_ID, 'boom', 'summarizing');
  dbMod.claimNextJob(db); // QUEUED_ID
  const claimedForDone = dbMod.claimNextJob(db); // DONE_ID
  assert.equal(claimedForDone?.id, DONE_ID);
  dbMod.markDone(db, DONE_ID, 'Title', '# Note');
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

describe('server — POST /api/jobs/:id/retry', () => {
  it('re-queues a failed job (200, queued, error cleared)', async () => {
    const res = await fetch(`${base}/api/jobs/${FAILED_ID}/retry`, { method: 'POST' });
    assert.equal(res.status, 200, `POST retry on failed job must be 200, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.jobId, FAILED_ID, `jobId ${body.jobId} must be the retried job`);
    assert.equal(body.status, 'queued', `status ${body.status} must be queued after retry`);
    assert.equal(body.error, null, `error ${String(body.error)} must be cleared after retry`);
    assert.equal(body.stage, null, `stage ${String(body.stage)} must be cleared after retry`);
    assert.equal(body.progress, 0, `progress ${String(body.progress)} must reset to 0 after retry`);

    const check = await fetch(`${base}/api/jobs/${FAILED_ID}`);
    assert.equal(((await check.json()) as { status?: string }).status, 'queued');
  });

  it('409 for a job that is no longer failed (already re-queued)', async () => {
    const res = await fetch(`${base}/api/jobs/${FAILED_ID}/retry`, { method: 'POST' });
    assert.equal(res.status, 409, `re-retrying a queued job must be 409, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Only failed jobs can be retried.');
  });

  it('409 for queued and done jobs', async () => {
    for (const id of [QUEUED_ID, DONE_ID]) {
      const res = await fetch(`${base}/api/jobs/${id}/retry`, { method: 'POST' });
      assert.equal(res.status, 409, `POST retry on ${id} must be 409, got ${res.status}`);
    }
  });

  it('404 for an unknown job', async () => {
    const res = await fetch(`${base}/api/jobs/does-not-exist/retry`, { method: 'POST' });
    assert.equal(res.status, 404, `POST retry on unknown job must be 404, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Job not found.');
  });
});
