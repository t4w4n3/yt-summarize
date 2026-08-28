/**
 * Behavioral tests for src/worker/stages/summarize.ts — the LLM summarization
 * outbound adapter. Exercises the real HTTPS call against a stubbed global
 * fetch, with the OpenRouter key resolved from the env fallback (no podman/GPG
 * present in the test sandbox), plus the pure extractContent helper.
 *
 * Category: integration — outbound adapter (stubbed HTTP).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { StageContext } from '../../src/worker/stages/process.ts';
import { extractContent, summarize } from '../../src/worker/stages/summarize.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-test-'));
}

function jsonResponse(status: number, payload: unknown, ok?: boolean): Response {
  return { ok: ok ?? status < 400, status, json: async () => payload } as unknown as Response;
}

function writeTranscript(dir: string, text: string): string {
  const p = path.join(dir, 'transcript.txt');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const originalFetch = globalThis.fetch;

describe('summarize — LLM outbound adapter', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
  });

  it('returns the extracted markdown content on a 200 response', async () => {
    const dir = tmpDir();
    const transcript = writeTranscript(dir, 'hello transcript');
    globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
      const body = JSON.parse(String(opts?.body)) as { messages?: unknown };
      assert.ok(Array.isArray(body.messages) && body.messages.length === 2, 'system + user messages');
      return jsonResponse(200, {
        choices: [{ message: { content: '# Summary\n\nGreat talk.' } }],
      });
    }) as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';

    try {
      const md = await summarize(transcript, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        lang: 'en',
      } as StageContext);
      assert.equal(md, '# Summary\n\nGreat talk.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips outer markdown code fences from the returned content', async () => {
    const dir = tmpDir();
    const transcript = writeTranscript(dir, 't');
    globalThis.fetch = (async () =>
      jsonResponse(200, { choices: [{ message: { content: '```markdown\n# Fenced\n```' } }] })) as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      const md = await summarize(transcript, {
        jobDir: dir,
        logPath: path.join(dir, 'stage.log'),
        timeoutMs: 5000,
        lang: 'fr',
      } as StageContext);
      assert.equal(md, '# Fenced');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a StageError when the API returns a non-200 with no usable content', async () => {
    const dir = tmpDir();
    const transcript = writeTranscript(dir, 't');
    globalThis.fetch = (async () => jsonResponse(429, { error: 'rate limited' })) as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      await assert.rejects(
        summarize(transcript, {
          jobDir: dir,
          logPath: path.join(dir, 'stage.log'),
          timeoutMs: 5000,
        } as StageContext),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { stage?: string }).stage, 'summarizing');
          assert.match(error.message, /HTTP 429/);
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a summarized timeout StageError when the request aborts', async () => {
    const dir = tmpDir();
    const transcript = writeTranscript(dir, 't');
    // A fetch that never resolves but honours the abort signal → abort fires the timeout branch.
    globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      await assert.rejects(
        summarize(transcript, {
          jobDir: dir,
          logPath: path.join(dir, 'stage.log'),
          timeoutMs: 50,
        } as StageContext),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { stage?: string }).stage, 'summarizing');
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extractContent pulls text out of defensive untyped bodies', () => {
    assert.equal(extractContent({ choices: [{ message: { content: 'ok' } }] }), 'ok');
    assert.equal(extractContent({ choices: [{ message: { content: 42 } }] }), null);
    assert.equal(extractContent({ choices: [] }), null);
    assert.equal(extractContent({}), null);
    assert.equal(extractContent(null), null);
    assert.equal(extractContent('string'), null);
  });
});
