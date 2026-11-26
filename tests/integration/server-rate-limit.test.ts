/**
 * Integration test for P3 (todo.md): security headers + rate limiting on the
 * real app server (src/infrastructure/inbound/http.ts) on an ephemeral port.
 *
 * The server is spawned with RATE_LIMIT_MAX=3 / RATE_LIMIT_WINDOW_MS=1500 so
 * the window reset is observable without waiting a minute. Order matters:
 * headers (GET, uncounted) → summarize exhaustion → GET unaffected → retry
 * limited → window reset.
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-rl-data-'));
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-rl-art-'));
process.env.DATA_DIR = dataDir;
process.env.ARTIFACTS_DIR = artifactsDir;

const FAILED_ID = '11111111-1111-4111-8111-111111111111';

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

function videoUrl(id11: string): string {
  return `https://youtu.be/${id11}`;
}

async function summarize(id11: string): Promise<Response> {
  return fetch(`${base}/api/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: videoUrl(id11) }),
  });
}

before(async () => {
  const db = dbMod.openDatabase();
  dbMod.createJob(db, FAILED_ID, 'https://youtu.be/AAAAAAAAAAA');
  dbMod.claimNextJob(db);
  dbMod.markFailed(db, FAILED_ID, 'boom', 'summarizing');
  dbMod.closeDatabase(db);

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn('node', ['src/infrastructure/inbound/http.ts'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ARTIFACTS_DIR: artifactsDir,
      RATE_LIMIT_MAX: '3',
      RATE_LIMIT_WINDOW_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

after(() => {
  child?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(artifactsDir, { recursive: true, force: true });
});

describe('server — security headers (P3)', () => {
  it('serves CSP, X-Content-Type-Options and X-Frame-Options on / and /api/*', async () => {
    for (const path of ['/', '/api/jobs']) {
      const res = await fetch(`${base}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.ok(
        csp.includes("default-src 'self'"),
        `GET ${path}: expected CSP containing "default-src 'self'", got ${JSON.stringify(csp)}`,
      );
      assert.ok(
        csp.includes("script-src 'self'"),
        `GET ${path}: expected CSP containing "script-src 'self'" (no inline scripts in the UI), got ${JSON.stringify(csp)}`,
      );
      assert.ok(
        csp.includes("frame-ancestors 'none'"),
        `GET ${path}: expected CSP containing "frame-ancestors 'none'", got ${JSON.stringify(csp)}`,
      );
      assert.equal(
        res.headers.get('x-content-type-options'),
        'nosniff',
        `GET ${path}: expected X-Content-Type-Options: nosniff`,
      );
      assert.equal(
        res.headers.get('x-frame-options'),
        'DENY',
        `GET ${path}: expected X-Frame-Options: DENY (the UI is never framed)`,
      );
    }
  });
});

describe('server — rate limiting on summarize + retry (P3)', () => {
  it('allows RATE_LIMIT_MAX summarize posts per window, then answers 429 with Retry-After', async () => {
    for (const [i, id] of ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'].entries()) {
      const res = await summarize(id);
      assert.equal(res.status, 201, `summarize #${i + 1} (${id}) within the limit: expected 201, got ${res.status}`);
    }
    const limited = await summarize('DDDDDDDDDDD');
    assert.equal(
      limited.status,
      429,
      '4th summarize within a 1500ms window with RATE_LIMIT_MAX=3: expected 429, got ' +
        `${limited.status} (rate limiter missing or off-by-one)`,
    );
    const retryAfter = limited.headers.get('retry-after');
    assert.ok(
      retryAfter !== null && Number(retryAfter) >= 1,
      `429 response: expected Retry-After >= 1s, got ${JSON.stringify(retryAfter)}`,
    );
    const body = (await limited.json()) as { error?: unknown };
    assert.ok(
      typeof body.error === 'string' && body.error.length > 0,
      `429 response: expected a JSON { error } body, got ${JSON.stringify(body)}`,
    );
  });

  it('does not count GET requests while the summarize quota is exhausted', async () => {
    const res = await fetch(`${base}/api/jobs`);
    assert.equal(res.status, 200, `GET /api/jobs while summarize is rate-limited: expected 200, got ${res.status}`);
  });

  it('limits POST /api/jobs/:id/retry with the same quota', async () => {
    const res = await fetch(`${base}/api/jobs/${FAILED_ID}/retry`, { method: 'POST' });
    assert.equal(
      res.status,
      429,
      `POST retry with the summarize quota already exhausted: expected 429, got ${res.status} (retry would re-queue paid work without any bound)`,
    );
  });

  it('resets the quota once the window expires', async () => {
    await new Promise((r) => setTimeout(r, 1700));
    const res = await summarize('EEEEEEEEEEE');
    assert.equal(
      res.status,
      201,
      `summarize after the 1500ms window expired: expected 201, got ${res.status} (window never resets)`,
    );
  });
});
