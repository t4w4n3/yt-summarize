/**
 * P1 — Wire domain ports: transcribe must delegate to injected
 * SpeechToTextPort / AudioSplitterPort (contract) instead of
 * hard-wired fetch/fs.
 *
 * This unit test drives the domain through fakes — no real HTTP,
 * no real 25 MB files, no ffmpeg. Before P1 it fails because
 * TranscribeContext ignores injected ports.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type {
  AudioSplitterPort,
  SpeechToTextPort,
  TranscriptionAttempt,
} from '../../src/domain/transcription/ports.ts';
import type { TranscribeContext } from '../../src/worker/stages/transcribe.ts';
import { transcribe } from '../../src/worker/stages/transcribe.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-ports-test-'));
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

function okAttempt(text: string): TranscriptionAttempt {
  return { httpStatus: 200, ok: true, text, errorDetails: '' };
}
function failAttempt(status: number, details: string): TranscriptionAttempt {
  return { httpStatus: status, ok: false, text: '', errorDetails: details };
}

describe('P1 — transcribe via injected ports (contract coupling)', () => {
  it('uses injected SpeechToTextPort — no fetch called', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    let multipartCalls = 0;
    let base64Calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        multipartCalls += 1;
        return okAttempt('hello from fake multipart');
      },
      async attemptBase64() {
        base64Calls += 1;
        return okAttempt('should not be called');
      },
    };
    const fakeSplitter: AudioSplitterPort = {
      async splitIntoChunks() {
        assert.fail('splitter should not be called for small file');
        return [];
      },
    };

    // Guard: if implementation still calls global fetch, fail the test
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when ports are injected');
    }) as typeof fetch;

    try {
      const out = await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        stt: fakeStt,
        splitter: fakeSplitter,
      } as unknown as TranscribeContext);

      assert.equal(fetchCalled, false, 'injected ports must bypass global fetch');
      assert.equal(multipartCalls, 1);
      assert.equal(base64Calls, 0);
      assert.ok(fs.existsSync(out));
      assert.equal(fs.readFileSync(out, 'utf8').trim(), 'hello from fake multipart');
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back via policy: multipart 413 → base64 → chunk, all via fakes', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    const calls: string[] = [];
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart(wavPath) {
        // First call (original file) → 413, later calls (chunks) → ok
        if (wavPath === wav) {
          calls.push('multipart:original');
          return failAttempt(
            413,
            'Multipart body exceeds the 25 MB upload limit. Send larger files as base64 JSON via input_audio.',
          );
        }
        calls.push(`multipart:${path.basename(wavPath)}`);
        return okAttempt(`text-${path.basename(wavPath)}`);
      },
      async attemptBase64() {
        calls.push('base64');
        return failAttempt(413, 'Multipart body exceeds the 25 MB upload limit.');
      },
    };
    let splitterCalled = false;
    const fakeSplitter: AudioSplitterPort = {
      async splitIntoChunks() {
        splitterCalled = true;
        // Fake two chunks — no real WAV slicing
        const chunkDir = path.join(dir, 'chunks');
        fs.mkdirSync(chunkDir, { recursive: true });
        const c1 = path.join(chunkDir, 'chunk_000.wav');
        const c2 = path.join(chunkDir, 'chunk_001.wav');
        writeSyntheticWav(c1, 512);
        writeSyntheticWav(c2, 512);
        return [c1, c2];
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch should not be called — all via fakes');
    }) as typeof fetch;

    try {
      const out = await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        stt: fakeStt,
        splitter: fakeSplitter,
      } as unknown as TranscribeContext);

      assert.ok(splitterCalled, 'chunk fallback should be triggered');
      assert.deepEqual(calls, ['multipart:original', 'base64', 'multipart:chunk_000.wav', 'multipart:chunk_001.wav']);
      const transcript = fs.readFileSync(out, 'utf8').trim();
      // joinTranscriptParts joins with blank line
      assert.equal(transcript, 'text-chunk_000.wav\n\ntext-chunk_001.wav');
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still works with default adapters when no fakes injected (backwards compat)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _opts?: RequestInit) => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ text: 'default adapter works' }) } as Response;
    }) as typeof fetch;

    try {
      const out = await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        // no stt/splitter — should use default adapters (fetch)
      } as unknown as TranscribeContext);
      assert.equal(fetchCalls, 1);
      assert.equal(fs.readFileSync(out, 'utf8').trim(), 'default adapter works');
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
