/**
 * Integration test for request-shape hardening (Ajv schemas + helmet) against
 * the real app server (src/infrastructure/inbound/http.ts) on an ephemeral
 * port. Fail-closed on unknown keys: query params or body fields outside the
 * documented shape are rejected (400) instead of being silently ignored, and
 * the security headers gain HSTS / Referrer-Policy via helmet while the
 * existing CSP / X-Frame-Options: DENY contract is preserved.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-validation-data-'));
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-validation-art-'));
process.env.DATA_DIR = dataDir;
process.env.ARTIFACTS_DIR = artifactsDir;

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
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn('node', ['src/infrastructure/inbound/http.ts'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ARTIFACTS_DIR: artifactsDir,
      // This file fires several summarize POSTs; keep the (separately tested)
      // rate limiter out of the way.
      RATE_LIMIT_MAX: '100',
      RATE_LIMIT_WINDOW_MS: '60000',
    },
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

function summarize(body: unknown): Promise<Response> {
  return fetch(`${base}/api/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('server — fail-closed request shapes', () => {
  it('rejects unknown query parameters on GET /api/jobs with 400', async () => {
    const res = await fetch(`${base}/api/jobs?admin=true`);
    assert.equal(res.status, 400, `?admin=true must be 400, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Unknown query parameter.', '?admin=true error text');
  });

  it('rejects bracket-style query keys (limit[]=1) instead of ignoring them', async () => {
    const res = await fetch(`${base}/api/jobs?limit%5B%5D=1`);
    assert.equal(res.status, 400, `?limit[]=1 must be 400, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Unknown query parameter.', '?limit[]=1 error text');
  });

  it('rejects unknown body fields on POST /api/summarize with 400', async () => {
    const res = await summarize({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', admin: true });
    assert.equal(res.status, 400, `extra body field must be 400, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Request body contains an unknown field.', 'extra body field error text');
  });

  it('keeps the legacy messages for wrong-typed url/lang (shape gate, domain messages)', async () => {
    const badLang = await summarize({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', lang: 42 });
    assert.equal(badLang.status, 400, `lang=42 must be 400, got ${badLang.status}`);
    assert.equal(
      ((await badLang.json()) as { error?: string }).error,
      'The output language must be a two-letter ISO 639-1 code.',
      'lang=42 error text',
    );

    const badUrl = await summarize({ url: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'] });
    assert.equal(badUrl.status, 400, `url as array must be 400, got ${badUrl.status}`);
    assert.equal(
      ((await badUrl.json()) as { error?: string }).error,
      'Enter a YouTube video URL.',
      'url as array error text',
    );
  });

  it('rejects a non-object JSON body on POST /api/summarize with 400', async () => {
    const res = await summarize('["https://www.youtube.com/watch?v=jNQXAC9IVRw"]');
    assert.equal(res.status, 400, `array body must be 400, got ${res.status}`);
    assert.equal(
      ((await res.json()) as { error?: string }).error,
      'Enter a YouTube video URL.',
      'array body error text',
    );
  });
});

describe('server — helmet security headers', () => {
  it('serves HSTS and Referrer-Policy while preserving CSP and X-Frame-Options: DENY', async () => {
    const res = await fetch(`${base}/api/jobs`);
    assert.equal(res.status, 200, `GET /api/jobs must be 200, got ${res.status}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ]) {
      assert.ok(csp.includes(directive), `CSP must keep "${directive}", got ${JSON.stringify(csp)}`);
    }
    assert.ok(!csp.includes('unsafe-inline'), `CSP must not gain unsafe-inline, got ${JSON.stringify(csp)}`);
    assert.ok(
      !csp.includes('upgrade-insecure-requests'),
      `CSP must not gain upgrade-insecure-requests (the app is served over plain HTTP on loopback), got ${JSON.stringify(csp)}`,
    );
    assert.equal(res.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options must stay DENY (not helmet SAMEORIGIN)');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options must stay nosniff');
    const hsts = res.headers.get('strict-transport-security') ?? '';
    assert.ok(
      hsts.includes('max-age='),
      `expected Strict-Transport-Security with max-age, got ${JSON.stringify(hsts)}`,
    );
    const referrer = res.headers.get('referrer-policy') ?? '';
    assert.ok(referrer.length > 0, `expected Referrer-Policy header, got ${JSON.stringify(referrer)}`);
    assert.equal(res.headers.get('x-powered-by'), null, 'X-Powered-By must stay absent');
  });
});
