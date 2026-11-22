/**
 * Integration tests for the pipeline stage-port facade (phase 2C).
 *
 * The real adapters are exercised through `tests/integration/pipeline-
 * orchestration.test.ts` with fake ports; this file pins the wiring shape
 * the pipeline depends on: exactly the four thin ports, each a single
 * callable method.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPipelineStagePorts } from '../../src/infrastructure/outbound/stages/stage-ports.ts';

describe('stage ports — facade shape', () => {
  it('exposes exactly the four thin outbound ports', () => {
    const ports = createPipelineStagePorts();
    assert.deepEqual(Object.keys(ports).sort(), ['converter', 'downloader', 'summarizer', 'transcriber']);
    assert.equal(typeof ports.downloader.download, 'function', 'downloader.download must be a function');
    assert.equal(typeof ports.converter.convert, 'function', 'converter.convert must be a function');
    assert.equal(typeof ports.transcriber.transcribe, 'function', 'transcriber.transcribe must be a function');
    assert.equal(typeof ports.summarizer.summarize, 'function', 'summarizer.summarize must be a function');
  });

  it('routes port inputs to the corresponding stage functions', async () => {
    const ports = createPipelineStagePorts({
      download: async (job, context) => ({ audioPath: `${context.jobDir}:${job.url}`, title: context.logPath }),
      convert: async (audioPath, context) => `${audioPath}→${context.logPath}`,
      transcribe: async (wavPath, context) => `${wavPath}→${context.jobDir}`,
      summarize: async (transcriptPath, context) => `${transcriptPath}:${context.lang ?? ''}`,
    });
    const context = { jobDir: '/job', logPath: '/log', timeoutMs: 123, signal: undefined };
    assert.deepEqual(await ports.downloader.download({ jobId: 'j1', url: 'https://youtu.be/abc', ...context }), {
      audioPath: '/job:https://youtu.be/abc',
      title: '/log',
    });
    assert.equal(await ports.converter.convert({ audioPath: '/job/audio.m4a', ...context }), '/job/audio.m4a→/log');
    assert.equal(await ports.transcriber.transcribe({ wavPath: '/job/audio.wav', ...context }), '/job/audio.wav→/job');
    assert.equal(
      await ports.summarizer.summarize({ transcriptPath: '/job/transcript.txt', lang: 'fr', ...context }),
      '/job/transcript.txt:fr',
    );
  });

  it('forwards the runtime config to adapters that need it', async () => {
    const runtimeConfig = {
      artifactsDir: '/artifacts',
      jobTimeoutMs: 1800000,
      sttModel: 'injected/stt-model',
      sttRetryMaxAttempts: 3,
      sttRetryBaseDelayMs: 1000,
      sttRetryMaxDelayMs: 8000,
      sttRetryAfterMaxMs: 120000,
      llmProvider: 'openrouter',
      llmModel: 'injected/llm-model',
      llmProviderPin: 'injected/provider',
      llmQuantization: '',
      llmThinking: 'high',
      mullvadEnabled: true,
      mullvadProxy: 'socks5h://127.0.0.1:9999',
    };
    const ports = createPipelineStagePorts(
      {
        download: async (_job, _ctx, cfg) => ({ audioPath: cfg?.mullvadProxy ?? '', title: '' }),
        convert: async (audioPath, _ctx) => audioPath,
        transcribe: async (_wavPath, _ctx, cfg) => cfg?.sttModel ?? '',
        summarize: async (_path, _ctx, cfg) => cfg?.llmModel ?? '',
      },
      runtimeConfig,
    );
    const context = { jobDir: '/job', logPath: '/log', timeoutMs: 1, signal: undefined };
    assert.equal(
      (await ports.downloader.download({ jobId: 'j1', url: 'u', ...context })).audioPath,
      'socks5h://127.0.0.1:9999',
    );
    assert.equal(await ports.transcriber.transcribe({ wavPath: '/job/a.wav', ...context }), 'injected/stt-model');
    assert.equal(await ports.summarizer.summarize({ transcriptPath: '/job/t.txt', ...context }), 'injected/llm-model');
  });
});
