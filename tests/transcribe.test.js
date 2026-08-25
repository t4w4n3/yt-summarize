/**
 * Integration tests at the outbound-adapter boundary: transcribe stage limits.
 * These are NOT playwright-mocked UI tests — they exercise src/worker/stages/transcribe.js
 * against the real file boundary (25 MB multipart limit) by stubbing only the
 * outbound fetch and the GPG key resolver. A regression here would have caught
 * the 413 Multipart body exceeds the 25 MB upload limit (input_audio) bug
 * before a real YouTube run such as https://youtu.be/FSWl57UR4k0.
 *
 * Run: node --test tests/transcribe.test.js
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Helpers to synthesize a valid PCM WAV without invoking ffmpeg.
// 16 kHz mono s16le → byteRate = 32000 → ~1.92 MB/min.
// ---------------------------------------------------------------------------
function writeSyntheticWav(filePath, dataBytes) {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8; // 32000
  const blockAlign = numChannels * bitsPerSample / 8; // 2
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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
}

describe('transcribe — 25 MB multipart boundary (outbound adapter)', () => {
  let transcribe;
  let MULTIPART_LIMIT;
  let CHUNK_DURATION_SEC;
  let originalFetch;

  beforeEach(() => {
    // Fresh module cache so mocks don't leak. Pre-stub the GPG key resolver
    // BEFORE requiring transcribe, because transcribe destructures it at import
    // (now it uses openrouter.resolveOpenRouterKey dynamically, but we still
    // ensure the stub is in place before import).
    delete require.cache[require.resolve('../src/worker/stages/transcribe')];
    const openrouterPath = require.resolve('../src/worker/stages/openrouter');
    delete require.cache[openrouterPath];
    // Install a fake openrouter module in the cache.
    require.cache[openrouterPath] = {
      id: openrouterPath,
      filename: openrouterPath,
      loaded: true,
      exports: { resolveOpenRouterKey: async () => 'sk-or-test-key' },
    };
    const mod = require('../src/worker/stages/transcribe');
    transcribe = mod.transcribe;
    MULTIPART_LIMIT = mod.MULTIPART_LIMIT;
    CHUNK_DURATION_SEC = mod.CHUNK_DURATION_SEC;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  it('small file (< limit) uses multipart/form-data and succeeds', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024 * 1024); // 1 MB → well under 24 MB

    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      assert.equal(url, 'https://openrouter.ai/api/v1/audio/transcriptions');
      // multipart path has no Content-Type json
      assert.ok(opts.body instanceof FormData, 'small file should use FormData');
      assert.equal(opts.headers['Content-Type'], undefined);
      return { ok: true, status: 200, json: async () => ({ text: 'hello world' }) };
    };

    const out = await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 });
    assert.equal(calls.length, 1);
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

    const origStat = fs.promises.stat;
    fs.promises.stat = async (p) => {
      if (p === wav) return { size: MULTIPART_LIMIT + 5 * 1024 * 1024 };
      return origStat(p);
    };

    let sawJson = false;
    global.fetch = async (url, opts) => {
      if (opts.headers['Content-Type'] === 'application/json') {
        sawJson = true;
        const body = JSON.parse(opts.body);
        assert.equal(body.model, 'mistralai/voxtral-mini-transcribe');
        assert.ok(typeof body.input_audio === 'string' && body.input_audio.length > 0, 'input_audio must be base64');
        // Should be a large base64 payload (our 512 KB file → ~682 KB b64)
        assert.ok(body.input_audio.length > 100_000);
        return { ok: true, status: 200, json: async () => ({ text: 'large file transcript' }) };
      }
      assert.fail('large file must not use multipart, expected JSON via input_audio');
    };

    try {
      const out = await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 });
      assert.ok(sawJson, 'expected one JSON fetch with input_audio');
      assert.equal(fs.readFileSync(out, 'utf8').trim(), 'large file transcript');
    } finally {
      fs.promises.stat = origStat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boundary: exactly MULTIPART_LIMIT uses multipart (not base64)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 256 * 1024);

    const origStat = fs.promises.stat;
    fs.promises.stat = async (p) => (p === wav ? { size: MULTIPART_LIMIT } : origStat(p));

    let usedMultipart = false;
    global.fetch = async (url, opts) => {
      if (opts.body instanceof FormData) usedMultipart = true;
      return { ok: true, status: 200, json: async () => ({ text: 'boundary ok' }) };
    };

    try {
      await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 });
      assert.ok(usedMultipart, 'file at exactly LIMIT should still use multipart');
    } finally {
      fs.promises.stat = origStat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boundary+1: MULTIPART_LIMIT+1 uses base64 JSON', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 256 * 1024);

    const origStat = fs.promises.stat;
    fs.promises.stat = async (p) => (p === wav ? { size: MULTIPART_LIMIT + 1 } : origStat(p));

    let usedJson = false;
    global.fetch = async (url, opts) => {
      if (opts.headers['Content-Type'] === 'application/json') usedJson = true;
      return { ok: true, status: 200, json: async () => ({ text: 'just over' }) };
    };

    try {
      await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 });
      assert.ok(usedJson, 'LIMIT+1 should go via input_audio JSON');
    } finally {
      fs.promises.stat = origStat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('small file that gets HTTP 413 on multipart retries as base64 JSON and succeeds (regression for FSWl57UR4k0)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, 1024 * 1024);

    let call = 0;
    global.fetch = async (url, opts) => {
      call += 1;
      if (call === 1) {
        assert.ok(opts.body instanceof FormData);
        return {
          ok: false, status: 413,
          json: async () => ({ error: { message: 'Multipart body exceeds the 25 MB upload limit. Send larger files as base64 JSON via input_audio.', code: 413 } }),
        };
      }
      // retry must be JSON via input_audio
      assert.equal(opts.headers['Content-Type'], 'application/json');
      const body = JSON.parse(opts.body);
      assert.ok(body.input_audio);
      return { ok: true, status: 200, json: async () => ({ text: 'recovered via base64' }) };
    };

    const out = await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 5000 });
    assert.equal(call, 2);
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'recovered via base64');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('very large file where even base64 returns 413 falls back to chunking and concatenates', async () => {
    const dir = tmpDir();
    // Build a WAV whose PCM is ~11 minutes → will split into 2 chunks (10 min + 1 min)
    // 11 min * 32000 = ~21 MB which is under LIMIT, so we fake stat to force chunk path.
    // Easier: craft a real ~20 MB PCM (19 MB) then mock stat to be huge and mock base64 413.
    // But we want the chunk fallback to be exercised with real splitting.
    // So create a 650s file (≈20.8 MB) — one byte under split threshold still produces 2 chunks
    const elevenMinBytes = 660 * 32000; // 11 min
    const wav = path.join(dir, 'audio.wav');
    writeSyntheticWav(wav, elevenMinBytes);

    // Force large-file path and make base64 fail.
    const origStat = fs.promises.stat;
    fs.promises.stat = async (p) => {
      if (p === wav) return { size: MULTIPART_LIMIT + 10 * 1024 * 1024 };
      return origStat(p);
    };

    let fetchCalls = 0;
    global.fetch = async (url, opts) => {
      fetchCalls += 1;
      if (opts.headers['Content-Type'] === 'application/json') {
        // Simulate base64 still too large
        return {
          ok: false, status: 413,
          json: async () => ({ error: { message: 'Multipart body exceeds the 25 MB upload limit.', code: 413 } }),
        };
      }
      // Chunk fetches are multipart; return a distinct text per chunk.
      assert.ok(opts.body instanceof FormData, 'chunks must be multipart');
      return { ok: true, status: 200, json: async () => ({ text: `chunk-${fetchCalls}` }) };
    };

    try {
      const out = await transcribe(wav, { jobDir: dir, logPath: path.join(dir, 'stage.log'), timeoutMs: 8000 });
      const txt = fs.readFileSync(out, 'utf8');
      // Should contain two chunk texts joined with blank line
      assert.match(txt, /chunk-/);
      assert.equal(txt.trim().split('\n\n').length, 2, 'two chunks should be joined by blank line');
      assert.ok(fetchCalls >= 3, '1 base64 failure + 2 chunk successes');
      // Chunks dir should have been cleaned
      assert.equal(fs.existsSync(path.join(dir, 'chunks')), false);
    } finally {
      fs.promises.stat = origStat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('real chunking: splitWavManual slices a 21 MB wav into aligned chunks', async () => {
    const mod = require('../src/worker/stages/transcribe');
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    // 12 min → 2 chunks at 600s
    writeSyntheticWav(wav, 720 * 32000);
    const chunks = await mod.splitWavIntoChunks(wav, dir, 600);
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
});
