import fs from 'node:fs';
import path from 'node:path';
import {
  alignedChunkBytes,
  CHUNK_DURATION_SEC,
  chooseInitialStrategy,
  joinTranscriptParts,
  nextAfterBase64Failure,
  nextAfterMultipartFailure,
} from '../../domain/transcription/policy.ts';
import type { AudioSplitterPort, SpeechToTextPort, TranscriptionAttempt } from '../../domain/transcription/ports.ts';
import { config } from '../../shared/config.ts';
import * as openrouter from './openrouter.ts';
import type { StageContext } from './process.ts';
import { runProcess, StageError } from './process.ts';

export { CHUNK_DURATION_SEC, MULTIPART_LIMIT } from '../../domain/transcription/policy.ts';

const API_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** StageContext plus dependency-injection hooks used by unit tests and for contract coupling. */
export interface TranscribeContext extends StageContext {
  /** Defaults to openrouter.resolveOpenRouterKey; injectable in tests. */
  resolveKey?: () => Promise<string>;
  /** Speech-to-text port — defaults to OpenRouter HTTPS adapter. Injected in unit tests via fakes. */
  stt?: SpeechToTextPort;
  /** Audio splitter port — defaults to manual PCM slicing + ffmpeg fallback. */
  splitter?: AudioSplitterPort;
}

function appendLog(logPath: string | undefined, line: string): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {}
}

function doFetch(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, options);
}

async function transcribeMultipartRaw(
  wavPath: string,
  apiKey: string,
  signal: AbortSignal,
  logPath: string | undefined,
): Promise<Response> {
  const audio = await fs.promises.readFile(wavPath);
  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(wavPath));
  appendLog(
    logPath,
    `$ POST ${API_URL} (model=${config.sttModel}, file=${path.basename(wavPath)}, ${audio.length} bytes, mode=multipart)`,
  );
  return doFetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
}

async function transcribeBase64Raw(
  wavPath: string,
  apiKey: string,
  signal: AbortSignal,
  logPath: string | undefined,
): Promise<Response> {
  const audio = await fs.promises.readFile(wavPath);
  const b64 = audio.toString('base64');
  appendLog(
    logPath,
    `$ POST ${API_URL} (model=${config.sttModel}, file=${path.basename(wavPath)}, ${audio.length} bytes, mode=base64:input_audio)`,
  );
  return doFetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.sttModel, input_audio: b64 }),
    signal,
  });
}

async function responseToAttempt(response: Response): Promise<TranscriptionAttempt> {
  let body: unknown = {};
  let raw = '';
  try {
    body = await response.json();
    raw = JSON.stringify(body).slice(0, 1000);
  } catch {
    body = {};
    raw = '';
  }
  const text = typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text.trim() : '';
  const ok = response.ok && !!text;
  // errorDetails must contain the body for policy classification (413 / 25 MB / input_audio)
  // and the HTTP status so that even empty bodies with 413 are detected.
  const errorDetails = ok ? '' : `${raw} HTTP ${response.status}`.trim();
  return {
    httpStatus: response.status,
    ok,
    text,
    errorDetails: errorDetails || raw,
  };
}

function createDefaultStt(logPath: string | undefined): SpeechToTextPort {
  return {
    async attemptMultipart(wavPath, apiKey, signal): Promise<TranscriptionAttempt> {
      try {
        const response = await transcribeMultipartRaw(wavPath, apiKey, signal, logPath);
        return await responseToAttempt(response);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const message = error instanceof Error ? error.message : String(error);
        // Network / file read errors become a failed attempt so policy can decide.
        // Throw only for abort — let caller handle retry classification.
        return { httpStatus: 0, ok: false, text: '', errorDetails: message };
      }
    },
    async attemptBase64(wavPath, apiKey, signal): Promise<TranscriptionAttempt> {
      try {
        const response = await transcribeBase64Raw(wavPath, apiKey, signal, logPath);
        return await responseToAttempt(response);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { httpStatus: 0, ok: false, text: '', errorDetails: message };
      }
    },
  };
}

function createDefaultSplitter(): AudioSplitterPort {
  return {
    async splitIntoChunks(wavPath, jobDir, chunkDurationSec): Promise<string[]> {
      return splitWavIntoChunks(wavPath, jobDir, chunkDurationSec);
    },
  };
}

// Split a 16 kHz mono s16le WAV into ~CHUNK_DURATION_SEC chunks by slicing
// the PCM data and rewriting a valid WAV header per chunk. This avoids a
// hard ffmpeg dependency and works in unit tests with synthetic WAVs.
// Falls back to ffmpeg segment if the header is non-standard.
export async function splitWavIntoChunks(
  wavPath: string,
  jobDir: string,
  chunkDurationSec = CHUNK_DURATION_SEC,
): Promise<string[]> {
  const chunkDir = path.join(jobDir, 'chunks');
  await fs.promises.mkdir(chunkDir, { recursive: true });

  // Try manual PCM slicing first (fast, no subprocess).
  try {
    const chunks = await splitWavManual(wavPath, chunkDir, chunkDurationSec);
    if (chunks.length > 0) return chunks;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(path.join(jobDir, 'stage.log'), `manual split failed (${message}), falling back to ffmpeg`);
  }

  // Fallback: ffmpeg segment
  const pattern = path.join(chunkDir, 'chunk_%03d.wav');
  // -f segment requires a muxer; pcm_s16le + wav works with segment.
  await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wavPath,
      '-f',
      'segment',
      '-segment_time',
      String(chunkDurationSec),
      '-reset_timestamps',
      '1',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      pattern,
    ],
    { stage: 'transcribing', timeoutMs: 5 * 60 * 1000 },
  );
  const files = (await fs.promises.readdir(chunkDir)).filter((f) => f.endsWith('.wav')).sort();
  return files.map((f) => path.join(chunkDir, f));
}

function buildWavHeader(numChannels: number, sampleRate: number, bitsPerSample: number, dataSize: number): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
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
  return header;
}

export async function splitWavManual(wavPath: string, chunkDir: string, chunkDurationSec: number): Promise<string[]> {
  const stat = await fs.promises.stat(wavPath);
  if (stat.size < 44) throw new Error('file too small to be wav');

  const fh = await fs.promises.open(wavPath, 'r');
  try {
    const riffHeader = Buffer.alloc(12);
    await fh.read(riffHeader, 0, 12, 0);
    if (riffHeader.toString('ascii', 0, 4) !== 'RIFF' || riffHeader.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a RIFF/WAVE file');
    }

    // Parse chunks to locate fmt and data — ffmpeg inserts a LIST chunk
    // (e.g. Lavf59.27.100) between fmt and data, so a fixed 44-byte header
    // is wrong. See failed job e5e31fbb (33 MB WAV → 70-byte garbage chunk).
    let offset = 12;
    let fmt: {
      audioFormat: number;
      numChannels: number;
      sampleRate: number;
      byteRate: number;
      blockAlign: number;
      bitsPerSample: number;
    } | null = null;
    let dataOffset = -1;
    let dataSize = -1;

    while (offset + 8 <= stat.size) {
      const chunkHeader = Buffer.alloc(8);
      await fh.read(chunkHeader, 0, 8, offset);
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      if (chunkId === 'fmt ') {
        // PCM fmt is 16 bytes; extensible may be larger — read at least 16.
        const fmtSize = chunkSize;
        if (fmtSize < 16) throw new Error('invalid fmt chunk');
        const fmtData = Buffer.alloc(fmtSize);
        await fh.read(fmtData, 0, fmtSize, offset + 8);
        fmt = {
          audioFormat: fmtData.readUInt16LE(0),
          numChannels: fmtData.readUInt16LE(2),
          sampleRate: fmtData.readUInt32LE(4),
          byteRate: fmtData.readUInt32LE(8),
          blockAlign: fmtData.readUInt16LE(12),
          bitsPerSample: fmtData.readUInt16LE(14),
        };
      } else if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }
      // Chunks are word-aligned: pad byte if size is odd.
      offset += 8 + chunkSize + (chunkSize % 2);
      // Guard against insane number of chunks / malformed file.
      if (offset > stat.size) break;
    }

    if (!fmt) throw new Error('fmt chunk not found');
    if (dataOffset < 0 || dataSize < 0) throw new Error('data chunk not found');

    if (fmt.audioFormat !== 1) throw new Error(`unsupported audioFormat ${fmt.audioFormat} (only PCM)`);
    const bytesPerSec = fmt.byteRate;
    const blockAlign = fmt.blockAlign;
    if (!bytesPerSec || !blockAlign) throw new Error('invalid wav header');

    // Domain policy: chunk length aligned to a sample frame so we never tear samples.
    const chunkBytes = alignedChunkBytes(bytesPerSec, blockAlign, chunkDurationSec);
    if (chunkBytes <= 0) throw new Error('chunk size 0');

    // Clamp dataSize to actual remaining bytes (truncated file guard).
    const available = stat.size - dataOffset;
    if (dataSize > available) dataSize = available;

    const dataEnd = dataOffset + dataSize;
    const files: string[] = [];
    let readOffset = dataOffset;
    let index = 0;
    while (readOffset < dataEnd) {
      const remaining = dataEnd - readOffset;
      const thisChunkSize = Math.min(chunkBytes, remaining);
      const aligned = Math.floor(thisChunkSize / blockAlign) * blockAlign || thisChunkSize;
      const buf = Buffer.alloc(aligned);
      await fh.read(buf, 0, aligned, readOffset);

      const chunkPath = path.join(chunkDir, `chunk_${String(index).padStart(3, '0')}.wav`);
      const outHeader = buildWavHeader(fmt.numChannels, fmt.sampleRate, fmt.bitsPerSample, aligned);
      await fs.promises.writeFile(chunkPath, Buffer.concat([outHeader, buf]));
      files.push(chunkPath);
      readOffset += aligned;
      index += 1;
      if (index > 1000) break;
    }
    return files;
  } finally {
    await fh.close();
  }
}

export async function transcribe(wavPath: string, context: TranscribeContext): Promise<string> {
  const resolveKey = context.resolveKey ?? openrouter.resolveOpenRouterKey;
  const apiKey = await resolveKey();

  const controller = new AbortController();
  const timeoutMs = context.timeoutMs || 25 * 60 * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;

  // Contract coupling: injected fakes in unit tests, default adapters in production.
  // This is the Balanced Coupling fix — high-strength intrusive fetch/fs is now
  // behind a weak contract (SpeechToTextPort / AudioSplitterPort), so
  // high-distance (core, volatile STT provider) is balanced by low strength.
  const stt: SpeechToTextPort = context.stt ?? createDefaultStt(context.logPath);
  const splitter: AudioSplitterPort = context.splitter ?? createDefaultSplitter();

  try {
    let statSize = 0;
    try {
      statSize = (await fs.promises.stat(wavPath)).size;
    } catch {}
    // Domain strategy (policy.ts): small → multipart first, large → base64 first.
    // Each failure is classified by the policy; anything that is not a known
    // limit error is rethrown instead of falling through.
    const initial = chooseInitialStrategy(statSize);

    let text: string | null = null;

    if (initial === 'multipart') {
      const attempt = await stt.attemptMultipart(wavPath, apiKey, signal);
      if (attempt.ok) {
        text = attempt.text;
      } else {
        const combined = `${attempt.errorDetails} HTTP ${attempt.httpStatus}`;
        if (nextAfterMultipartFailure(combined) === null) {
          throw new StageError(
            `Transcription failed (HTTP ${attempt.httpStatus || 0}).`,
            'transcribing',
            attempt.errorDetails,
          );
        }
        appendLog(context.logPath, `multipart hit 413 (size=${statSize}), retrying as base64 JSON via input_audio`);
        text = null;
      }
    }

    if (text === null) {
      // For large files or small files that got 413, try base64 JSON.
      const attempt = await stt.attemptBase64(wavPath, apiKey, signal);
      if (attempt.ok) {
        text = attempt.text;
      } else {
        const combined = `${attempt.errorDetails} HTTP ${attempt.httpStatus}`;
        if (nextAfterBase64Failure(combined, statSize) === null) {
          throw new StageError(
            `Transcription failed (HTTP ${attempt.httpStatus || 0}).`,
            'transcribing',
            attempt.errorDetails,
          );
        }
        appendLog(
          context.logPath,
          `base64 still hit 413 or large file fallback (size=${statSize}), splitting into ${CHUNK_DURATION_SEC}s chunks`,
        );
        text = null;
      }
    }

    if (text === null) {
      // Final fallback: chunk and transcribe sequentially.
      const chunkPaths = await splitter.splitIntoChunks(wavPath, context.jobDir, CHUNK_DURATION_SEC);
      if (chunkPaths.length === 0) throw new StageError('Could not split audio for transcription.', 'transcribing');
      appendLog(context.logPath, `split into ${chunkPaths.length} chunk(s), transcribing sequentially`);
      const parts: string[] = [];
      for (const chunkPath of chunkPaths) {
        appendLog(context.logPath, `transcribing chunk ${path.basename(chunkPath)}`);
        const chunkAttempt = await stt.attemptMultipart(chunkPath, apiKey, signal);
        if (!chunkAttempt.ok || !chunkAttempt.text) {
          throw new StageError(
            `Transcription failed (HTTP ${chunkAttempt.httpStatus || 0}).`,
            'transcribing',
            chunkAttempt.errorDetails || `empty chunk ${path.basename(chunkPath)}`,
          );
        }
        parts.push(chunkAttempt.text);
      }
      text = joinTranscriptParts(parts);
      // Clean up chunk dir (keep on failure for debugging).
      try {
        await fs.promises.rm(path.join(context.jobDir, 'chunks'), { recursive: true, force: true });
      } catch {}
    }

    const transcriptPath = path.join(context.jobDir, 'transcript.txt');
    fs.writeFileSync(transcriptPath, `${text}\n`, 'utf8');
    appendLog(context.logPath, `transcript.txt: ${text.split(/\s+/).length} words`);
    return transcriptPath;
  } catch (error) {
    if (context.signal?.aborted) {
      throw new StageError('The job was cancelled.', 'transcribing');
    }
    if (error instanceof StageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';
    // Abort from the internal timeout controller
    if (name === 'AbortError') {
      throw new StageError('Transcription timed out.', 'transcribing', message);
    }
    throw new StageError('The transcription API could not be reached.', 'transcribing', message);
  } finally {
    clearTimeout(timeout);
  }
}
