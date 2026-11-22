/**
 * Config-injection tests for the pipeline stage adapters (phase 3A).
 *
 * A runtime config handed to a stage must win over process.env and the shared
 * singleton. These tests assert the configured value reaches the wire.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { RuntimeConfig } from '../../src/application/config.ts';
import { download } from '../../src/infrastructure/outbound/stages/download.ts';
import { summarize } from '../../src/infrastructure/outbound/stages/summarize.ts';
import { type TranscribeContext, transcribe } from '../../src/infrastructure/outbound/stages/transcribe.ts';
import { loadConfig } from '../../src/shared/config.ts';

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { ...loadConfig({}), ...overrides };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stage-config-'));
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload, headers: new Headers() } as unknown as Response;
}

const originalFetch = globalThis.fetch;

describe('stage adapters — injected RuntimeConfig', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
  });

  it('download routes yt-dlp through the injected Mullvad proxy', async () => {
    const dir = tmpDir();
    const argLog = path.join(dir, 'yt-args');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'));
    const yt = path.join(binDir, 'yt-dlp');
    fs.writeFileSync(
      yt,
      `#!/bin/sh
printf '%s\n' "$@" > "${argLog}"
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then output="$a"; fi
  prev="$a"
done
jobdir="$(dirname "$output")"
printf 'Title\n' > "$jobdir/.title"
: > "$jobdir/audio.webm"
exit 0
`,
    );
    fs.chmodSync(yt, 0o755);
    const originalPath = process.env.PATH;
    const originalMullvadEnabled = process.env.MULLVAD_ENABLED;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.MULLVAD_ENABLED = 'false';
    try {
      await download(
        { url: 'https://youtu.be/abc' },
        { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 },
        runtimeConfig({ mullvadEnabled: true, mullvadProxy: 'socks5h://127.0.0.1:9999' }),
      );
      const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
      const proxyIdx = args.indexOf('--proxy');
      assert.ok(proxyIdx !== -1, 'injected Mullvad proxy must be forwarded to yt-dlp');
      assert.equal(args[proxyIdx + 1], 'socks5h://127.0.0.1:9999');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMullvadEnabled === undefined) delete process.env.MULLVAD_ENABLED;
      else process.env.MULLVAD_ENABLED = originalMullvadEnabled;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarize sends the injected llmModel / provider pin', async () => {
    const dir = tmpDir();
    const transcript = path.join(dir, 'transcript.txt');
    fs.writeFileSync(transcript, 'hello transcript');
    let body: { model?: string; provider?: unknown } = {};
    globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
      body = JSON.parse(String(opts?.body)) as { model?: string; provider?: unknown };
      return jsonResponse({ choices: [{ message: { content: '# Summary' } }] });
    }) as typeof fetch;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';

    await summarize(
      transcript,
      { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000, lang: 'en' },
      runtimeConfig({ llmModel: 'injected/llm-model', llmProviderPin: 'injected/provider', llmQuantization: 'fp8' }),
    );
    assert.equal(body.model, 'injected/llm-model', 'summarize must use the injected llmModel');
    assert.deepEqual(body.provider, { only: ['injected/provider'], allow_fallbacks: false, quantizations: ['fp8'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('transcribe sends the injected sttModel', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36, 4);
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
    header.writeUInt32LE(0, 40);
    fs.writeFileSync(wav, header);

    let model: unknown;
    globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
      const form = opts?.body as FormData;
      model = form.get('model');
      return jsonResponse({ text: 'hello from stt' });
    }) as typeof fetch;
    const context: TranscribeContext = {
      jobDir: dir,
      logPath: path.join(dir, 'stage.log'),
      timeoutMs: 5000,
      resolveKey: async () => 'sk-or-test',
      sleep: async () => {},
    };
    await transcribe(wav, context, runtimeConfig({ sttModel: 'injected/stt-model' }));
    assert.equal(model, 'injected/stt-model', 'transcribe must use the injected sttModel');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
