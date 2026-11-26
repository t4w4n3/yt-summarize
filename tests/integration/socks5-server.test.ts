/**
 * Integration test du serveur SOCKS5 Mullvad (src/vpn/socks5.ts), lancé en
 * sous-processus sur un port éphémère (même patron que server-rate-limit).
 *
 * Vérifie le câblage de src/vpn/socks-policy.ts dans le serveur réel :
 *  - un CONNECT vers une IP bloquée (loopback) est refusé, même si un
 *    service écoute réellement dessus ;
 *  - le cap de connexions simultanées ferme la (N+1)-e connexion ;
 *  - une connexion inactive est coupée après le timeout d'inactivité.
 *
 * Category: integration — real TCP sockets, no external network.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.join(import.meta.dirname, '..', '..');

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

interface RunningSocks {
  child: ChildProcess;
  port: number;
  stop: () => Promise<void>;
}

async function startSocks(env: Record<string, string>): Promise<RunningSocks> {
  const port = await freePort();
  const child = spawn('node', ['src/vpn/socks5.ts'], {
    cwd: ROOT,
    env: { ...process.env, SOCKS_HOST: '127.0.0.1', SOCKS_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`socks5 exited early with code ${String(child.exitCode)}`);
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.connect({ port, host: '127.0.0.1' });
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`socks5 did not listen on 127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    child,
    port,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    },
  };
}

function connectRaw(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Envoie le greeting SOCKS5 et attend la réponse [05 00]. */
async function greet(socket: net.Socket): Promise<void> {
  const reply = new Promise<void>((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => {
      if (chunk[0] === 0x05 && chunk[1] === 0x00) resolve();
      else reject(new Error(`unexpected greeting reply ${chunk.toString('hex')}`));
    });
    socket.once('error', reject);
  });
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  await reply;
}

function connectRequest(ip: string, port: number): Buffer {
  const octets = ip.split('.').map((p) => Number(p));
  return Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets, (port >> 8) & 0xff, port & 0xff]);
}

/** Collecte les données jusqu'à la fermeture, ou timeoutMs. */
async function collectUntilClose(socket: net.Socket, timeoutMs: number): Promise<{ data: Buffer; closed: boolean }> {
  const chunks: Buffer[] = [];
  let closed = false;
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('close', () => {
      closed = true;
      done();
    });
    socket.once('error', done);
  });
  return { data: Buffer.concat(chunks), closed };
}

async function waitClosed(socket: net.Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('socks5 — deny, cap et timeouts (câblage du serveur)', () => {
  it('refuse un CONNECT vers 127.0.0.1 même si un service y écoute', async () => {
    // Upstream réel sur loopback : sans filtre, le serveur réussirait le CONNECT.
    const upstream = net.createServer((s) => s.end('hello'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddr = upstream.address();
    const upstreamPort = typeof upstreamAddr === 'object' && upstreamAddr ? upstreamAddr.port : 0;
    const socks = await startSocks({ SOCKS_IDLE_TIMEOUT_MS: '10000' });
    try {
      const socket = await connectRaw(socks.port);
      socket.on('error', () => {});
      await greet(socket);
      socket.write(connectRequest('127.0.0.1', upstreamPort));
      const { data, closed } = await collectUntilClose(socket, 3_000);
      const successReply = data.length >= 4 && data[0] === 0x05 && data[1] === 0x00 && data[2] === 0x00;
      assert.equal(
        successReply,
        false,
        `CONNECT 127.0.0.1:${upstreamPort} must not succeed, got reply ${data.toString('hex')}`,
      );
      assert.equal(
        closed,
        true,
        `CONNECT 127.0.0.1:${upstreamPort} must close the client socket, got open socket with reply ${data.toString('hex')}`,
      );
      socket.destroy();
    } finally {
      await socks.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('ferme la (N+1)-e connexion au-delà du cap', async () => {
    const socks = await startSocks({ SOCKS_MAX_CONNECTIONS: '2', SOCKS_IDLE_TIMEOUT_MS: '10000' });
    const held: net.Socket[] = [];
    try {
      held.push(await connectRaw(socks.port), await connectRaw(socks.port));
      for (const s of held) s.on('error', () => {});
      await new Promise((r) => setTimeout(r, 150)); // laisse le serveur compter les 2 premières
      const extra = await connectRaw(socks.port);
      extra.on('error', () => {});
      const closed = await waitClosed(extra, 3_000);
      assert.equal(closed, true, '3rd connection (cap=2) must be closed by the server');
      extra.destroy();
    } finally {
      for (const s of held) s.destroy();
      await socks.stop();
    }
  });

  it('coupe une connexion inactive apres le timeout idle', async () => {
    const socks = await startSocks({ SOCKS_IDLE_TIMEOUT_MS: '1000' });
    try {
      const socket = await connectRaw(socks.port);
      socket.on('error', () => {});
      const closed = await waitClosed(socket, 5_000);
      assert.equal(closed, true, 'idle connection (no greeting sent) must be closed after 1000ms idle timeout');
      socket.destroy();
    } finally {
      await socks.stop();
    }
  });
});
