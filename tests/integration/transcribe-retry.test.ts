/**
 * Transient provider failures (429 / 5xx) must be retried a bounded number of
 * times inside the transcribe stage; definitive failures (4xx) must not.
 *
 * Driven through fakes: no HTTP, no real backoff (the sleep is injected), so
 * every case asserts on call counts and on the delays the stage asked for.
 *
 * Failure that motivated this: job f826aaaf died on a single upstream
 * `{"error":{"message":"Provider returned 429","code":429}}` while the same
 * request succeeded seconds later.
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
import type { TranscribeContext } from '../../src/infrastructure/outbound/stages/transcribe.ts';
import { transcribe } from '../../src/infrastructure/outbound/stages/transcribe.ts';

const RETRY = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 } as const;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-retry-test-'));
}

function writeSyntheticWav(filePath: string, dataBytes = 1024): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(dataBytes, 0)]));
}

function okAttempt(text: string): TranscriptionAttempt {
  return { httpStatus: 200, ok: true, text, errorDetails: '' };
}
function failAttempt(status: number, details: string, retryAfterMs?: number): TranscriptionAttempt {
  return { httpStatus: status, ok: false, text: '', errorDetails: details, retryAfterMs };
}

/** The exact 402 OpenRouter returned on job 1954b724 (chunk 6/6 of a 100-minute video). */
const IN_FLIGHT_402 =
  '{"error":{"message":"This request would exceed your available credits given your current in-flight requests.","code":402,"metadata":{"reason":"in_flight_budget_exhausted","headers":{"Retry-After":"120"}}}} HTTP 402';
const OUT_OF_CREDIT_402 = '{"error":{"message":"Insufficient credits","code":402}} HTTP 402';

/** Context for a small file: multipart is the first strategy. */
function makeContext(
  dir: string,
  stt: SpeechToTextPort,
  sleeps: number[],
  splitter?: AudioSplitterPort,
): TranscribeContext {
  return {
    jobDir: dir,
    logPath: path.join(dir, 'stage.log'),
    timeoutMs: 5000,
    resolveKey: async () => 'sk-or-test',
    stt,
    splitter,
    retry: RETRY,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  } as unknown as TranscribeContext;
}

describe('transcribe — transient failures (429 / 5xx)', () => {
  it('429 then 200 ⇒ the same multipart request is retried and the job succeeds', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    const statuses: string[] = [];
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        statuses.push('multipart');
        return statuses.length === 1
          ? failAttempt(429, '{"error":{"message":"Provider returned 429","code":429}} HTTP 429')
          : okAttempt('transcript after retry');
      },
      async attemptBase64() {
        assert.fail('429 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    // Captured instead of awaited: the red state throws, and we want the
    // diagnostic to be the attempt count, not a stack trace.
    let outcome: { out?: string; error?: unknown } = {};
    try {
      outcome = { out: await transcribe(wav, makeContext(dir, fakeStt, sleeps)) };
    } catch (error) {
      outcome = { error };
    }

    try {
      assert.equal(statuses.length, 2, 'one 429 then one 200 ⇒ 2 multipart attempts');
      assert.equal(sleeps.length, 1, 'one retry ⇒ exactly one wait');
      const delay = sleeps[0] ?? -1;
      assert.ok(delay >= 500 && delay <= 1000, `first retry delay ${delay}ms must sit in [500, 1000] for base 1000ms`);
      assert.equal(outcome.error, undefined, 'the retried request succeeded — no stage error');
      assert.equal(fs.readFileSync(String(outcome.out), 'utf8').trim(), 'transcript after retry');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('definitive 400 ⇒ no retry, one attempt only', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return failAttempt(400, '{"error":{"message":"bad audio"}} HTTP 400');
      },
      async attemptBase64() {
        calls += 1;
        return failAttempt(400, '{"error":{"message":"bad audio"}} HTTP 400');
      },
    };

    let message = '';
    try {
      await transcribe(wav, makeContext(dir, fakeStt, sleeps));
      assert.fail('a 400 must fail the stage');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // 400 is not a size-limit error, so the size policy does not switch strategy
    // either — one multipart attempt, no wait, stage failed.
    assert.equal(calls, 1, '400 is definitive: exactly one attempt, no retry');
    assert.equal(sleeps.length, 0, 'no wait may happen for a definitive failure');
    assert.equal(message, 'Transcription failed (HTTP 400).');
  });

  it('persistent 503 ⇒ stops after maxAttempts and reports the HTTP status', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return failAttempt(503, '{"error":{"message":"Provider returned 503","code":503}} HTTP 503');
      },
      async attemptBase64() {
        assert.fail('503 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    let message = '';
    try {
      await transcribe(wav, makeContext(dir, fakeStt, sleeps));
      assert.fail('persistent 503 must fail the stage');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(calls, 3, 'maxAttempts 3 ⇒ exactly 3 attempts on a persistent 503');
    assert.equal(sleeps.length, 2, '3 attempts ⇒ 2 waits between them');
    const total = sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(
      total <= 2 * RETRY.maxDelayMs,
      `total backoff ${total}ms must stay under 2 × maxDelay ${RETRY.maxDelayMs}ms`,
    );
    assert.equal(message, 'Transcription failed (HTTP 503).');
  });

  it('without an injected budget, the config defaults apply (3 attempts, 1 s base)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return failAttempt(429, '{"error":{"message":"Provider returned 429","code":429}} HTTP 429');
      },
      async attemptBase64() {
        assert.fail('429 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    let message = '';
    try {
      await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        stt: fakeStt,
        // no `retry` — the stage must fall back to the config defaults
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      } as unknown as TranscribeContext);
      assert.fail('persistent 429 must fail the stage once the budget is spent');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(calls, 3, 'default budget is 3 attempts');
    assert.equal(sleeps.length, 2, '3 attempts ⇒ 2 waits');
    const first = sleeps[0] ?? -1;
    assert.ok(first >= 500 && first <= 1000, `default first delay ${first}ms must sit in [500, 1000] (base 1000ms)`);
    assert.equal(message, 'Transcription failed (HTTP 429).');
  });

  it('chunk fallback is retried too: 503 then 200 on the first chunk', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    const calls: string[] = [];
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart(wavPath) {
        if (wavPath === wav) {
          calls.push('multipart:original');
          return failAttempt(413, 'Multipart body exceeds the 25 MB upload limit.');
        }
        calls.push(`multipart:${path.basename(wavPath)}`);
        const chunkSeen = calls.filter((c) => c === 'multipart:chunk_000.wav').length;
        return chunkSeen === 1 ? failAttempt(503, 'HTTP 503') : okAttempt('chunk text');
      },
      async attemptBase64() {
        calls.push('base64');
        return failAttempt(413, 'Multipart body exceeds the 25 MB upload limit.');
      },
    };
    const chunkDir = path.join(dir, 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunk = path.join(chunkDir, 'chunk_000.wav');
    writeSyntheticWav(chunk, 512);
    const fakeSplitter: AudioSplitterPort = {
      async splitIntoChunks() {
        return [chunk];
      },
    };

    let outcome: { out?: string; error?: unknown } = {};
    try {
      outcome = { out: await transcribe(wav, makeContext(dir, fakeStt, sleeps, fakeSplitter)) };
    } catch (error) {
      outcome = { error };
    }

    try {
      assert.deepEqual(
        calls,
        ['multipart:original', 'base64', 'multipart:chunk_000.wav', 'multipart:chunk_000.wav'],
        'the failed chunk request is retried once before giving up',
      );
      assert.equal(sleeps.length, 1, 'one retried chunk ⇒ one wait');
      assert.equal(outcome.error, undefined, 'the retried chunk succeeded — no stage error');
      assert.equal(fs.readFileSync(String(outcome.out), 'utf8').trim(), 'chunk text');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('402 in_flight_budget_exhausted ⇒ waits the hinted Retry-After (120 s) and retries', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return calls === 1 ? failAttempt(402, IN_FLIGHT_402, 120_000) : okAttempt('transcript after the wait');
      },
      async attemptBase64() {
        assert.fail('an in-flight 402 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    let outcome: { out?: string; error?: unknown } = {};
    try {
      outcome = { out: await transcribe(wav, makeContext(dir, fakeStt, sleeps)) };
    } catch (error) {
      outcome = { error };
    }

    try {
      assert.equal(calls, 2, 'one in-flight 402 then one 200 ⇒ 2 multipart attempts');
      assert.deepEqual(sleeps, [120_000], 'the provider asked for 120 s — that is the wait, not the 1 s backoff');
      assert.equal(outcome.error, undefined, 'the retried request succeeded — no stage error');
      assert.equal(fs.readFileSync(String(outcome.out), 'utf8').trim(), 'transcript after the wait');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a Retry-After above the ceiling is clamped to retryAfterMaxMs', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        // 600 s requested, ceiling at 30 s
        return calls === 1 ? failAttempt(402, IN_FLIGHT_402, 600_000) : okAttempt('clamped ok');
      },
      async attemptBase64() {
        assert.fail('an in-flight 402 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    const context = { ...makeContext(dir, fakeStt, sleeps), retry: { ...RETRY, retryAfterMaxMs: 30_000 } };
    try {
      await transcribe(wav, context as unknown as TranscribeContext);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.deepEqual(sleeps, [30_000], '600 s hint clamped to the injected 30 s ceiling');
    assert.equal(calls, 2, 'the clamped wait is still followed by exactly one retry');
  });

  it('without an injected budget, the config ceiling (120 s) clamps the hint', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return calls === 1 ? failAttempt(402, IN_FLIGHT_402, 600_000) : okAttempt('config default ok');
      },
      async attemptBase64() {
        assert.fail('an in-flight 402 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    try {
      await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        stt: fakeStt,
        // no `retry` — the stage must fall back to the config defaults
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      } as unknown as TranscribeContext);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.deepEqual(sleeps, [120_000], 'the config default STT_RETRY_AFTER_MAX_MS (120 s) clamps a 600 s hint');
    assert.equal(calls, 2, 'the clamped wait is still followed by exactly one retry');
  });

  it('402 without the in-flight marker (no credit left) ⇒ definitive, one attempt, no wait', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const sleeps: number[] = [];
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        return failAttempt(402, OUT_OF_CREDIT_402);
      },
      async attemptBase64() {
        calls += 1;
        return failAttempt(402, OUT_OF_CREDIT_402);
      },
    };

    let message = '';
    try {
      await transcribe(wav, makeContext(dir, fakeStt, sleeps));
      assert.fail('an out-of-credit 402 must fail the stage');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(calls, 1, 'out of credit is definitive: exactly one attempt, no retry');
    assert.equal(sleeps.length, 0, 'no wait may happen when the account is simply out of credit');
    assert.equal(message, 'Transcription failed (HTTP 402).');
  });

  it('cancelling during the wait ends the job at once, without waiting out the backoff', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);

    const controller = new AbortController();
    let calls = 0;
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart() {
        calls += 1;
        // The job is cancelled while the stage is backing off for the retry.
        setTimeout(() => controller.abort(), 20);
        return failAttempt(429, '{"error":{"message":"Provider returned 429","code":429}} HTTP 429');
      },
      async attemptBase64() {
        assert.fail('429 is not a size-limit error — base64 must not be tried');
        return okAttempt('');
      },
    };

    const started = Date.now();
    let message = '';
    try {
      await transcribe(wav, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        resolveKey: async () => 'sk-or-test',
        stt: fakeStt,
        retry: RETRY,
        signal: controller.signal,
        // real default wait — the abort must cut it short
      } as unknown as TranscribeContext);
      assert.fail('a cancelled job must not finish the stage');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const elapsed = Date.now() - started;
    assert.equal(message, 'The job was cancelled.');
    assert.equal(calls, 1, 'no further attempt after the abort');
    assert.ok(elapsed < 400, `cancelled after ${elapsed}ms — the first backoff alone is ≥ 500ms`);
  });

  it('retry resume: cached chunk transcripts are reused, only missing chunks are paid for', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav);
    const chunkDir = path.join(dir, 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunk0 = path.join(chunkDir, 'chunk_000.wav');
    const chunk1 = path.join(chunkDir, 'chunk_001.wav');
    writeSyntheticWav(chunk0, 512);
    writeSyntheticWav(chunk1, 512);
    // Partial transcript from the failed attempt: chunk 0 already paid for.
    fs.writeFileSync(path.join(chunkDir, 'chunk_000.txt'), 'cached chunk text');
    const fakeSplitter: AudioSplitterPort = {
      async splitIntoChunks() {
        return [chunk0, chunk1];
      },
    };
    const calls: string[] = [];
    const fakeStt: SpeechToTextPort = {
      async attemptMultipart(file) {
        calls.push(path.basename(file));
        return okAttempt('second chunk text');
      },
      async attemptBase64() {
        calls.push('base64');
        return okAttempt('whole-file text');
      },
    };
    const sleeps: number[] = [];
    let outcome: { out?: string; error?: unknown } = {};
    try {
      outcome = { out: await transcribe(wav, makeContext(dir, fakeStt, sleeps, fakeSplitter)) };
    } catch (error) {
      outcome = { error };
    }
    try {
      assert.equal(outcome.error, undefined, `resume must succeed, got ${String(outcome.error)}`);
      assert.deepEqual(
        calls,
        ['chunk_001.wav'],
        `calls ${calls} must pay only for the missing chunk — no whole-file retry, no chunk_000`,
      );
      const text = fs.readFileSync(String(outcome.out), 'utf8').trim();
      assert.equal(
        text,
        'cached chunk text\n\nsecond chunk text',
        `transcript ${JSON.stringify(text)} must join cached + new parts`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
