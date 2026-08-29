/**
 * Regression for e5e31fbb (bzYziksDslU): ffmpeg's WAV always contains a LIST
 * chunk (Lavf59.27.100) between fmt and data. The old splitWavManual assumed
 * a fixed 44-byte header (data at 44, dataSize at 40) and produced a single
 * 70-byte garbage chunk (header + 26 B of LIST) → provider 400.
 *
 * This test synthesizes the exact ffmpeg layout and asserts the fixed parser
 * finds the data chunk at 78 and slices 2 valid PCM chunks.
 *
 * Category: integration — real fs, no HTTP.
 * Run: pnpm run test:integration
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { splitWavIntoChunks, splitWavManual } from '../../src/worker/stages/transcribe.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-list-'));
}

// Minimal 44-byte WAV helper (existing tests) is not enough — we need the
// exact ffmpeg layout: RIFF WAVE | fmt(16) | LIST(26) | data.
function writeFfmpegLikeWav(filePath: string, dataBytes: number): void {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  // fmt chunk payload (16 bytes PCM)
  const fmtPayload = Buffer.alloc(16);
  fmtPayload.writeUInt16LE(1, 0); // PCM
  fmtPayload.writeUInt16LE(numChannels, 2);
  fmtPayload.writeUInt32LE(sampleRate, 4);
  fmtPayload.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 8); // byteRate 32000
  fmtPayload.writeUInt16LE((numChannels * bitsPerSample) / 8, 12); // blockAlign 2
  fmtPayload.writeUInt16LE(bitsPerSample, 14);
  const fmtChunk = Buffer.alloc(8 + 16);
  fmtChunk.write('fmt ', 0);
  fmtChunk.writeUInt32LE(16, 4);
  fmtPayload.copy(fmtChunk, 8);

  // LIST chunk as emitted by ffmpeg 5.1.9 (Lavf59.27.100), 26 bytes payload.
  // Hex dump of a real ffmpeg WAV: 4c4953541a000000494e464f495346540e0000004c61766635392e32372e31303000
  const listChunk = Buffer.from('4c4953541a000000494e464f495346540e0000004c61766635392e32372e31303000', 'hex');

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(dataBytes, 4);

  const riffSize = 4 + fmtChunk.length + listChunk.length + dataHeader.length + dataBytes;
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(riffSize, 4);
  riff.write('WAVE', 8);

  // PCM payload: fill with 0x11 so we can later verify slicing preserved data (not LIST).
  const pcm = Buffer.alloc(dataBytes, 0x11);
  fs.writeFileSync(filePath, Buffer.concat([riff, fmtChunk, listChunk, dataHeader, pcm]));
}

function readWavHeader(filePath: string): { riff: string; wave: string; dataSize: number; fileSize: number } {
  const fd = fs.openSync(filePath, 'r');
  const hdr = Buffer.alloc(44);
  fs.readSync(fd, hdr, 0, 44, 0);
  fs.closeSync(fd);
  return {
    riff: hdr.toString('ascii', 0, 4),
    wave: hdr.toString('ascii', 8, 12),
    dataSize: hdr.readUInt32LE(40),
    fileSize: fs.statSync(filePath).size,
  };
}

describe('transcribe — ffmpeg LIST chunk regression (e5e31fbb)', () => {
  it('splitWavManual parses ffmpeg WAV with LIST and slices into 2 valid chunks (33 MB case)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    // Data size from failed job: audio.wav 33_901_304 B → header 78 B → PCM 33_901_226 B.
    // That's 19_200_000 (10 min) + 14_701_226 → 2 chunks.
    const pcmBytes = 33_901_226;
    writeFfmpegLikeWav(wav, pcmBytes);
    assert.equal(fs.statSync(wav).size, 33_901_304, 'synthetic ffmpeg WAV must match failed job size');

    const chunkDir = path.join(dir, 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });

    const chunks = await splitWavManual(wav, chunkDir, 600);
    // Old code produced 1 chunk of 70 B (header + LIST). Fixed code must produce 2.
    assert.equal(chunks.length, 2, 'ffmpeg WAV with LIST must split into 2 chunks, not 1×70 B garbage');

    // Each chunk must be a minimal 44-byte PCM WAV (no LIST), block-aligned, and sum to original PCM.
    let totalPcm = 0;
    for (const [idx, c] of chunks.entries()) {
      const h = readWavHeader(c);
      assert.equal(h.riff, 'RIFF', `chunk ${idx} must be RIFF`);
      assert.equal(h.wave, 'WAVE', `chunk ${idx} must be WAVE`);
      assert.equal(h.fileSize, 44 + h.dataSize, `chunk ${idx} fileSize must equal 44+dataSize`);
      assert.ok(h.dataSize > 0 && h.dataSize <= 19_200_000, `chunk ${idx} dataSize must be a valid slice`);
      assert.equal(h.dataSize % 2, 0, `chunk ${idx} must be block-aligned (2)`);
      // Verify the chunk's PCM payload is the original 0x11 fill, not the LIST payload (INFOISFT/Lavf).
      const fd = fs.openSync(c, 'r');
      const firstByte = Buffer.alloc(1);
      fs.readSync(fd, firstByte, 0, 1, 44);
      fs.closeSync(fd);
      assert.equal(firstByte[0], 0x11, `chunk ${idx} PCM must be original audio, not LIST bytes`);
      totalPcm += h.dataSize;
    }
    assert.equal(totalPcm, pcmBytes, 'sum of chunk PCM must equal original PCM (no loss, no LIST bytes)');

    // Regression guard: the 70-byte garbage file must NOT appear.
    for (const c of chunks)
      assert.notEqual(fs.statSync(c).size, 70, 'must not produce the old 70-byte LIST garbage chunk');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splitWavIntoChunks delegates to fixed manual path for ffmpeg WAV (no ffmpeg fallback needed)', async () => {
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    // Smaller but still >1 chunk: 660 s → 21_120_000 B PCM → 2 chunks (600 s + 60 s)
    writeFfmpegLikeWav(wav, 660 * 32_000);
    const chunks = await splitWavIntoChunks(wav, dir, 600);
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
      const h = readWavHeader(c);
      assert.equal(h.riff, 'RIFF');
      assert.ok(h.fileSize > 44);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('minimal 44-byte WAV (no LIST) still slices correctly — backwards compat with existing synthetic tests', async () => {
    // This is the layout used by transcribe-boundary.test.ts; must keep passing.
    const dir = tmpDir();
    const wav = path.join(dir, 'audio.wav');
    const dataBytes = 720 * 32_000; // 12 min → 2 chunks
    // Build without LIST
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
    fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(dataBytes, 0x22)]));
    const chunkDir = path.join(dir, 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunks = await splitWavManual(wav, chunkDir, 600);
    assert.equal(chunks.length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
