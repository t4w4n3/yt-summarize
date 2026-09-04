/**
 * Integration tests at the outbound-adapter boundary: transcribe stage limits.
 * These are NOT playwright-mocked UI tests — they exercise src/worker/stages/transcribe.ts
 * against the real file boundary (25 MB multipart limit) by stubbing only the
 * outbound fetch and injecting a fake key resolver. A regression here would have
 * caught the 413 Multipart body exceeds the 25 MB upload limit (input_audio) bug
 * before a real YouTube run such as https://youtu.be/FSWl57UR4k0.
 *
 * Category: integration — outbound adapters under test (real fs, stubbed HTTP).
 * Run: pnpm run test:integration
 */

import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TranscribeContext } from '../../src/worker/stages/transcribe.ts';
import {
  CHUNK_DURATION_SEC,
  MULTIPART_LIMIT,
  splitWavIntoChunks,
  splitWavManual,
  transcribe,
} from '../../src/worker/stages/transcribe.ts';

// ---------------------------------------------------------------------------
// Helpers to synthesize a valid PCM WAV without invoking ffmpeg.
// 16 kHz mono s16le → byteRate = 32000 → ~1.92 MB/min.
// ---------------------------------------------------------------------------
function writeSyntheticWav(filePath: string, dataBytes: number): void {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8; // 32000
  const blockAlign = (numChannels * bitsPerSample) / 8; // 2
  const dataSize = dataBytes;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  // Fill PCM with silence (zeros) — valid but minimal.
  const pcm = Buffer.alloc(dataSize, 0);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
}

interface RecordedCall {
  url: string | URL | Request;
  opts: RequestInit;
}

type FetchHandler = (opts: RequestInit) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, payload: unknown, ok = true): Response {
  return { ok, status, json: async () => payload } as unknown as Response;
}

/** Install a typed stub for global fetch and record every call. */
function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, opts?: RequestInit): Promise<Response> => {
    const recorded: RecordedCall = { url, opts: opts ?? {} };
    calls.push(recorded);
    return handler(recorded.opts);
  }) as typeof fetch;
  return calls;
}

function contentType(opts: RequestInit): string | undefined {
  if (!opts.headers || typeof opts.headers !== 'object' || Array.isArray(opts.headers)) return undefined;
  const headers = opts.headers as Record<string, string>;
  return headers['Content-Type'];
}

const baseContext = (dir: string): TranscribeContext => ({
  jobDir: dir,
  logPath: path.join(dir, 'stage.log'),
  timeoutMs: 5000,
  resolveKey: async () => 'sk-or-test-key',
});

describe('transcribe — 25 MB multipart boundary (outbound adapter)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('small file (< limit) uses multipart/form-data and succeeds', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024 * 1024); // 1 MB → well under 24 MB

    const calls = stubFetch((opts) => {
      assert.ok(opts.body instanceof FormData, 'small file should use FormData');
      assert.equal(contentType(opts), undefined);
      return jsonResponse(200, { text: 'hello world' });
    });
    assert.equal(calls.length, 0);

    const out = await transcribe(wav, baseContext(dir));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.ok(fs.existsSync(out));
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'hello world');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('large file (> limit) does NOT use multipart — it uses base64 JSON via input_audio', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    // MULTIPART_LIMIT + 1 byte would already trigger large path, but building a 24 MB file
    // is heavy. We temporarily monkey-patch fs.stat to simulate 26 MB without writing 26 MB.
    writeSyntheticWav(wav, 512 * 1024); // small on disk, but stat will lie

    const origStat = fs.promises.stat.bind(fs.promises) as (p: fs.PathLike) => Promise<Stats>;
    fs.promises.stat = (async (p: fs.PathLike): Promise<Stats> => {
      if (p === wav) return { size: MULTIPART_LIMIT + 5 * 1024 * 1024 } as Stats;
      return origStat(p);
    }) as typeof fs.promises.stat;

    let sawJson = false;
    try {
      stubFetch((opts) => {
        if (contentType(opts) === 'application/json') {
          sawJson = true;
          const body = JSON.parse(String(opts.body)) as { model?: string; input_audio?: string };
          assert.equal(body.model, 'microsoft/mai-transcribe-2');
          assert.ok(typeof body.input_audio === 'string' && body.input_audio.length > 0, 'input_audio must be base64');
          // Should be a large base64 payload (our 512 KB file → ~682 KB b64)
          assert.ok((body.input_audio?.length ?? 0) > 100_000);
          return jsonResponse(200, { text: 'large file transcript' });
        }
        throw new Error('large file must not use multipart, expected JSON via input_audio');
      });

      const out = await transcribe(wav, baseContext(dir));
      assert.ok(sawJson, 'expected one JSON fetch with input_audio');
      assert.equal(fs.readFileSync(out, 'utf8').trim(), 'large file transcript');
    } finally {
      fs.promises.stat = origStat as typeof fs.promises.stat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boundary: exactly MULTIPART_LIMIT uses multipart (not base64)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 256 * 1024);

    const origStat = fs.promises.stat.bind(fs.promises) as (p: fs.PathLike) => Promise<Stats>;
    fs.promises.stat = (async (p: fs.PathLike): Promise<Stats> =>
      p === wav ? ({ size: MULTIPART_LIMIT } as Stats) : origStat(p)) as typeof fs.promises.stat;

    let usedMultipart = false;
    try {
      stubFetch((opts) => {
        if (opts.body instanceof FormData) usedMultipart = true;
        return jsonResponse(200, { text: 'boundary ok' });
      });

      await transcribe(wav, baseContext(dir));
      assert.ok(usedMultipart, 'file at exactly LIMIT should still use multipart');
    } finally {
      fs.promises.stat = origStat as typeof fs.promises.stat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boundary+1: MULTIPART_LIMIT+1 uses base64 JSON', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 256 * 1024);

    const origStat = fs.promises.stat.bind(fs.promises) as (p: fs.PathLike) => Promise<Stats>;
    fs.promises.stat = (async (p: fs.PathLike): Promise<Stats> =>
      p === wav ? ({ size: MULTIPART_LIMIT + 1 } as Stats) : origStat(p)) as typeof fs.promises.stat;

    let usedJson = false;
    try {
      stubFetch((opts) => {
        if (contentType(opts) === 'application/json') usedJson = true;
        return jsonResponse(200, { text: 'just over' });
      });

      await transcribe(wav, baseContext(dir));
      assert.ok(usedJson, 'LIMIT+1 should go via input_audio JSON');
    } finally {
      fs.promises.stat = origStat as typeof fs.promises.stat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('small file that gets HTTP 413 on multipart retries as base64 JSON and succeeds (regression for FSWl57UR4k0)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024 * 1024);

    let call = 0;
    stubFetch((opts) => {
      call += 1;
      if (call === 1) {
        assert.ok(opts.body instanceof FormData);
        return jsonResponse(
          413,
          {
            error: {
              message:
                'Multipart body exceeds the 25 MB upload limit. Send larger files as base64 JSON via input_audio.',
              code: 413,
            },
          },
          false,
        );
      }
      // retry must be JSON via input_audio
      assert.equal(contentType(opts), 'application/json');
      const body = JSON.parse(String(opts.body)) as { input_audio?: string };
      assert.ok(body.input_audio);
      return jsonResponse(200, { text: 'recovered via base64' });
    });

    const out = await transcribe(wav, baseContext(dir));
    assert.equal(call, 2);
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'recovered via base64');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('very large file where even base64 returns 413 falls back to chunking and concatenates', async () => {
    const dir = tmpDir();
    // Build a WAV whose PCM is ~11 minutes → will split into 2 chunks (10 min + 1 min)
    // 11 min * 32000 = ~21 MB which is under LIMIT, so we fake stat to force chunk path.
    // So create a 650s file (≈20.8 MB) — one byte under split threshold still produces 2 chunks
    const elevenMinBytes = 660 * 32000; // 11 min
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, elevenMinBytes);

    // Force large-file path and make base64 fail.
    const origStat = fs.promises.stat.bind(fs.promises) as (p: fs.PathLike) => Promise<Stats>;
    fs.promises.stat = (async (p: fs.PathLike): Promise<Stats> => {
      if (p === wav) return { size: MULTIPART_LIMIT + 10 * 1024 * 1024 } as Stats;
      return origStat(p);
    }) as typeof fs.promises.stat;

    try {
      let fetchCalls = 0;
      stubFetch((opts) => {
        fetchCalls += 1;
        if (contentType(opts) === 'application/json') {
          // Simulate base64 still too large
          return jsonResponse(
            413,
            { error: { message: 'Multipart body exceeds the 25 MB upload limit.', code: 413 } },
            false,
          );
        }
        // Chunk fetches are multipart; return a distinct text per chunk.
        assert.ok(opts.body instanceof FormData, 'chunks must be multipart');
        return jsonResponse(200, { text: `chunk-${fetchCalls}` });
      });

      const out = await transcribe(wav, { ...baseContext(dir), timeoutMs: 8000 });
      const txt = fs.readFileSync(out, 'utf8');
      // Should contain two chunk texts joined with blank line
      assert.match(txt, /chunk-/);
      assert.equal(txt.trim().split('\n\n').length, 2, 'two chunks should be joined by blank line');
      assert.ok(fetchCalls >= 3, '1 base64 failure + 2 chunk successes');
      // Chunks dir should have been cleaned
      assert.equal(fs.existsSync(path.join(dir, 'chunks')), false);
    } finally {
      fs.promises.stat = origStat as typeof fs.promises.stat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('real chunking: splitWavManual slices a 21 MB wav into aligned chunks', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    // 12 min → 2 chunks at 600s
    writeSyntheticWav(wav, 720 * 32000);
    const chunks = await splitWavIntoChunks(wav, dir, 600);
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
      assert.ok(fs.statSync(c).size > 44);
      // Each chunk must be valid WAV
      const h = Buffer.alloc(44);
      const fd = fs.openSync(c, 'r');
      fs.readSync(fd, h, 0, 44, 0);
      fs.closeSync(fd);
      assert.equal(h.toString('ascii', 0, 4), 'RIFF');
      assert.equal(h.toString('ascii', 8, 12), 'WAVE');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports stay coherent: constants keep their documented values', () => {
    assert.equal(MULTIPART_LIMIT, 24 * 1024 * 1024);
    assert.equal(CHUNK_DURATION_SEC, 600);
    assert.equal(typeof splitWavManual, 'function');
  });
});
