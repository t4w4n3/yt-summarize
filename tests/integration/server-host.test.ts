/**
 * Integration test for the app bind address (HOST) against the real app
 * server (src/infrastructure/inbound/http.ts) on an ephemeral port.
 *
 * Default is loopback only (127.0.0.1): a host-run app must not answer on the
 * LAN. HOST=0.0.0.0 is the explicit opt-in for all interfaces (the container
 * path, where compose publishes loopback-only). Proven through the listening
 * log line, loopback reachability, and — when the host has a non-loopback
 * address — the external address refusing/accepting connections.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

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

function firstExternalIPv4(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

async function withServer(
  envExtra: Record<string, string>,
  run: (base: string, port: number, stdout: () => string) => Promise<void>,
): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-host-data-'));
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-host-art-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let out = '';
  const child: ChildProcess = spawn('node', ['src/infrastructure/inbound/http.ts'], {
    cwd: path.join(import.meta.dirname, '..', '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ARTIFACTS_DIR: artifactsDir, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(`${base}/api/jobs/nonexistent`);
        if (res.status === 404) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server did not come up at ${base}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // The listening line is logged in the listen callback, before the 404
    // above can succeed; give the pipe a beat so the assertion sees it.
    await new Promise((r) => setTimeout(r, 50));
    await run(base, port, () => out);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status === 404;
  } catch {
    return false;
  }
}

describe('server — bind host (HOST)', () => {
  it('binds loopback only by default: loopback answers, the external address refuses', async () => {
    const external = firstExternalIPv4();
    await withServer({}, async (base, port, stdout) => {
      assert.ok(
        stdout().includes(`http://127.0.0.1:${port}`),
        `default bind: expected listening log on 127.0.0.1, got ${JSON.stringify(stdout())}`,
      );
      assert.equal(
        await reachable(`${base}/api/jobs/nonexistent`),
        true,
        'loopback must answer when bound to 127.0.0.1',
      );
      if (external !== undefined) {
        assert.equal(
          await reachable(`http://${external}:${port}/api/jobs/nonexistent`),
          false,
          `external address ${external} must refuse connections when bound to loopback only`,
        );
      }
    });
  });

  it('HOST=0.0.0.0 opts into all interfaces: loopback and the external address answer', async () => {
    const external = firstExternalIPv4();
    await withServer({ HOST: '0.0.0.0' }, async (base, port, stdout) => {
      assert.ok(
        stdout().includes(`http://0.0.0.0:${port}`),
        `HOST=0.0.0.0: expected listening log on 0.0.0.0, got ${JSON.stringify(stdout())}`,
      );
      assert.equal(await reachable(`${base}/api/jobs/nonexistent`), true, 'loopback must answer when bound to 0.0.0.0');
      if (external !== undefined) {
        assert.equal(
          await reachable(`http://${external}:${port}/api/jobs/nonexistent`),
          true,
          `external address ${external} must answer when bound to 0.0.0.0`,
        );
      }
    });
  });
});
