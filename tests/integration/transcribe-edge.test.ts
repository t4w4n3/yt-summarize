/**
 * Edge-path integration tests for the transcribe stage (src/worker/stages/transcribe.ts).
 *
 * The happy/fallback paths are covered by transcribe-boundary.test.ts (real
 * fetch, 413 retry, chunking) and the injected-port paths by
 * transcribe-ports.test.ts. This file closes the residual gaps: JSON-parse /
 * network-error handling in the default adapter, policy-throw branches, the
 * chunk-transcription failure branch, the outer error mapping (cancelled /
 * timeout / generic), and the ffmpeg-fallback in splitWavIntoChunks.
 *
 * Category: integration — real fs + stubbed fetch / fake CLI on PATH.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { SpeechToTextPort } from '../../src/domain/transcription/ports.ts';
import type { TranscribeContext } from '../../src/worker/stages/transcribe.ts';
import { splitWavIntoChunks, transcribe } from '../../src/worker/stages/transcribe.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-edge-'));
}

function writeSyntheticWav(filePath: string, dataBytes = 1024): void {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = 32000;
  const blockAlign = 2;
  const dataSize = dataBytes;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(dataSize, 0)]));
}

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function baseContext(dir: string, extra: Partial<TranscribeContext> = {}): TranscribeContext {
  return {
    jobDir: dir,
    logPath: path.join(dir, 'stage.log'),
    timeoutMs: 5000,
    resolveKey: async () => 'sk-or-test',
    ...extra,
  } as TranscribeContext;
}

function stubFetch(handler: (opts: RequestInit) => Response | Promise<Response> | never): void {
  globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit): Promise<Response> =>
    handler(opts ?? {})) as typeof fetch;
}

function jsonResponse(status: number, payload: unknown, ok = true): Response {
  return { ok, status, json: async () => payload } as unknown as Response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
});

describe('transcribe — default adapter error handling', () => {
  it('treats a JSON parse failure as a failed attempt and throws a StageError (small file)', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    stubFetch(
      () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('bad json')) }) as unknown as Response,
    );

    await assert.rejects(transcribe(wav, baseContext(dir)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Transcription failed/);
      return true;
    });
  });

  it('a network error on multipart becomes a failed attempt then a StageError', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    stubFetch(() => {
      throw new Error('socket hang up');
    });

    await assert.rejects(transcribe(wav, baseContext(dir)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Transcription failed/);
      return true;
    });
  });

  it('a network error on base64 (large file) falls through to chunking via the splitter', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    // Force large-file strategy: try base64 first → network error → chunk.
    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = (async (p: fs.PathLike) => {
      const st = (await realStat(p)) as { size: number };
      return { ...st, size: 30 * 1024 * 1024 };
    }) as typeof fs.promises.stat;
    fs.promises.stat = statSpy;

    let chunkCalls = 0;
    stubFetch(() => {
      throw new Error('base64 socket hang up');
    });

    try {
      const out = await transcribe(wav, {
        ...baseContext(dir),
        splitter: {
          async splitIntoChunks() {
            chunkCalls += 1;
            const chunkDir = path.join(dir, 'chunks');
            fs.mkdirSync(chunkDir, { recursive: true });
            const c1 = path.join(chunkDir, 'chunk_000.wav');
            const c2 = path.join(chunkDir, 'chunk_001.wav');
            writeSyntheticWav(c1, 512);
            writeSyntheticWav(c2, 512);
            return [c1, c2];
          },
        },
        stt: {
          async attemptBase64() {
            return { httpStatus: 0, ok: false, text: '', errorDetails: 'base64 socket hang up' as string };
          },
          async attemptMultipart() {
            return { httpStatus: 200, ok: true, text: 'chunk-text', errorDetails: '' };
          },
        },
      });
      assert.equal(chunkCalls, 1);
      assert.ok(fs.existsSync(out));
    } finally {
      fs.promises.stat = realStat as typeof fs.promises.stat;
    }
  });

  it('small file: multipart 413 → base64 non-413 → throws (policy has no next strategy)', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    let calls = 0;
    stubFetch((opts) => {
      calls += 1;
      if (opts.body instanceof FormData) {
        return jsonResponse(
          413,
          { error: { message: 'Multipart body exceeds the 25 MB upload limit.', code: 413 } },
          false,
        );
      }
      return jsonResponse(500, { error: { message: 'server exploded' } }, false);
    });

    await assert.rejects(transcribe(wav, baseContext(dir)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Transcription failed \(HTTP 500\)/);
      return true;
    });
    assert.equal(calls, 2);
  });

  it('a failed chunk in the chunking fallback throws a StageError', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        return { httpStatus: 500, ok: false, text: '', errorDetails: 'chunk rejected' };
      },
      async attemptBase64() {
        return { httpStatus: 0, ok: false, text: '', errorDetails: '' };
      },
    };

    await assert.rejects(
      transcribe(wav, {
        ...baseContext(dir),
        stt: fakeStt,
        splitter: {
          async splitIntoChunks() {
            const chunkDir = path.join(dir, 'chunks');
            fs.mkdirSync(chunkDir, { recursive: true });
            const c1 = path.join(chunkDir, 'chunk_000.wav');
            writeSyntheticWav(c1, 512);
            return [c1];
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Transcription failed \(HTTP 500\)/);
        return true;
      },
    );
  });
});

describe('transcribe — outer error mapping', () => {
  it('maps an already-aborted context signal to a cancellation StageError', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);
    const controller = new AbortController();
    controller.abort();

    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        throw new Error('boom');
      },
      async attemptBase64() {
        throw new Error('boom');
      },
    };

    await assert.rejects(
      transcribe(wav, { ...baseContext(dir), stt: fakeStt, signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /cancelled/);
        return true;
      },
    );
  });

  it('maps an AbortError (name) to a timeout StageError', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        const e = new Error('aborted by controller');
        e.name = 'AbortError';
        throw e;
      },
      async attemptBase64() {
        throw new Error('unreachable');
      },
    };

    await assert.rejects(transcribe(wav, { ...baseContext(dir), stt: fakeStt }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      return true;
    });
  });

  it('maps a generic error to a could-not-be-reached StageError', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        throw new Error('dns resolution failed');
      },
      async attemptBase64() {
        throw new Error('unreachable');
      },
    };

    await assert.rejects(transcribe(wav, { ...baseContext(dir), stt: fakeStt }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /could not be reached/i);
      return true;
    });
  });
});

describe('splitWavIntoChunks — ffmpeg fallback', () => {
  it('falls back to fake ffmpeg when manual split fails on a non-RIFF file', async () => {
    const dir = tmpDir();
    tempDirs.push(dir);
    // A 100-byte file that is not RIFF/WAVE → splitWavManual throws.
    const wav = path.join(dir, 'not-wav.bin');
    fs.writeFileSync(wav, Buffer.alloc(100, 7));

    // Fake ffmpeg on PATH: last arg is the output pattern; write two chunks.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-ffmpeg-'));
    tempDirs.push(binDir);
    fs.writeFileSync(
      path.join(binDir, 'ffmpeg'),
      `#!/usr/bin/env bash\npattern=""; for a in "$@"; do pattern="$a"; done\noutdir="$(dirname "$pattern")"\n: > "$outdir/chunk_000.wav"\n: > "$outdir/chunk_001.wav"\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${originalPath}`;

    const chunks = await splitWavIntoChunks(wav, dir, 600);
    assert.equal(chunks.length, 2);
    for (const c of chunks) assert.ok(fs.existsSync(c));
  });
});
