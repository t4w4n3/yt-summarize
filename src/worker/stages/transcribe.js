const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../../shared/constants');
const { StageError } = require('./process');
const openrouter = require('./openrouter');

const API_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

// Keep 1 MB headroom for multipart overhead (boundaries, headers).
const MULTIPART_LIMIT = 24 * 1024 * 1024;
const CHUNK_DURATION_SEC = 600; // 10 min → ~19 MB at 16 kHz mono s16le

function appendLog(logPath, line) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {}
}

async function doFetch(url, options) {
  return fetch(url, options);
}

async function transcribeMultipart(wavPath, apiKey, signal, logPath) {
  const audio = await fs.promises.readFile(wavPath);
  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(wavPath));
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

async function transcribeBase64(wavPath, apiKey, signal, logPath) {
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

async function handleResponse(response) {
  const body = await response.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!response.ok || !text) {
    throw new StageError(
      `Transcription failed (HTTP ${response.status}).`,
      'transcribing',
      JSON.stringify(body).slice(0, 1000),
    );
  }
  return { text, body };
}

// Split a 16 kHz mono s16le WAV into ~CHUNK_DURATION_SEC chunks by slicing
// the PCM data and rewriting a valid WAV header per chunk. This avoids a
// hard ffmpeg dependency and works in unit tests with synthetic WAVs.
// Falls back to ffmpeg segment if the header is non-standard.
async function splitWavIntoChunks(wavPath, jobDir, chunkDurationSec = CHUNK_DURATION_SEC) {
  const chunkDir = path.join(jobDir, 'chunks');
  await fs.promises.mkdir(chunkDir, { recursive: true });

  // Try manual PCM slicing first (fast, no subprocess).
  try {
    const chunks = await splitWavManual(wavPath, chunkDir, chunkDurationSec);
    if (chunks.length > 0) return chunks;
  } catch (e) {
    appendLog(path.join(jobDir, 'stage.log'), `manual split failed (${e.message}), falling back to ffmpeg`);
  }

  // Fallback: ffmpeg segment
  const { runProcess } = require('./process');
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

async function splitWavManual(wavPath, chunkDir, chunkDurationSec) {
  const stat = await fs.promises.stat(wavPath);
  if (stat.size < 44) throw new Error('file too small to be wav');

  const fh = await fs.promises.open(wavPath, 'r');
  try {
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);

    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a RIFF/WAVE file');
    }
    const audioFormat = header.readUInt16LE(20);
    const _numChannels = header.readUInt16LE(22);
    const _sampleRate = header.readUInt32LE(24);
    const byteRate = header.readUInt32LE(28);
    const blockAlign = header.readUInt16LE(32);
    const _bitsPerSample = header.readUInt16LE(34);
    const dataSize = header.readUInt32LE(40);

    if (audioFormat !== 1) throw new Error(`unsupported audioFormat ${audioFormat} (only PCM)`);
    // Sanity: byteRate should equal sampleRate * numChannels * bitsPerSample/8
    const bytesPerSec = byteRate;
    if (!bytesPerSec || !blockAlign) throw new Error('invalid wav header');

    const chunkBytesRaw = bytesPerSec * chunkDurationSec;
    // Align down to blockAlign so we never split a sample frame.
    const chunkBytes = Math.floor(chunkBytesRaw / blockAlign) * blockAlign;
    if (chunkBytes <= 0) throw new Error('chunk size 0');

    const dataOffset = 44;
    const dataEnd = dataOffset + dataSize;
    const files = [];
    let offset = dataOffset;
    let index = 0;
    while (offset < dataEnd) {
      const remaining = dataEnd - offset;
      const thisChunkSize = Math.min(chunkBytes, remaining);
      // Ensure last chunk is also block-aligned (except EOF already is).
      const aligned = Math.floor(thisChunkSize / blockAlign) * blockAlign || thisChunkSize;
      const buf = Buffer.alloc(aligned);
      await fh.read(buf, 0, aligned, offset);

      const chunkPath = path.join(chunkDir, `chunk_${String(index).padStart(3, '0')}.wav`);
      const outHeader = Buffer.from(header);
      outHeader.writeUInt32LE(36 + aligned, 4); // chunkSize
      outHeader.writeUInt32LE(aligned, 40); // dataSize
      await fs.promises.writeFile(chunkPath, Buffer.concat([outHeader, buf]));
      files.push(chunkPath);
      offset += aligned;
      index += 1;
      // Guard against pathological loops.
      if (index > 1000) break;
    }
    return files;
  } finally {
    await fh.close();
  }
}

async function transcribe(wavPath, context) {
  const apiKey = await openrouter.resolveOpenRouterKey();

  const controller = new AbortController();
  const timeoutMs = context.timeoutMs || 25 * 60 * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;

  let response;
  let stat;
  try {
    try {
      stat = await fs.promises.stat(wavPath);
    } catch {
      stat = { size: 0 };
    }
    const isLarge = stat.size > MULTIPART_LIMIT;

    // Strategy:
    // - small file: try multipart, on 413 fall through to base64, then chunking.
    // - large file: try base64 directly (as the API suggests), on 413 fall through to chunking.
    // Chunking is the final safety net and works for arbitrarily long audio.

    const tryHandle = async (resp) => {
      const { text } = await handleResponse(resp);
      return text;
    };

    let text = null;

    if (!isLarge) {
      try {
        response = await transcribeMultipart(wavPath, apiKey, signal, context.logPath);
        text = await tryHandle(response);
      } catch (error) {
        const msg = `${error.message} ${error.details || ''}`;
        const is413 = msg.includes('413') || msg.includes('25 MB') || msg.includes('input_audio');
        if (!is413) throw error;
        appendLog(context.logPath, `multipart hit 413 (size=${stat.size}), retrying as base64 JSON via input_audio`);
        // fall through to base64
        text = null;
      }
    }

    if (text === null) {
      // For large files or small files that got 413, try base64 JSON.
      try {
        response = await transcribeBase64(wavPath, apiKey, signal, context.logPath);
        text = await tryHandle(response);
      } catch (error) {
        const msg = `${error.message} ${error.details || ''}`;
        const is413 = msg.includes('413') || msg.includes('25 MB');
        if (!is413 && stat.size <= MULTIPART_LIMIT) throw error;
        appendLog(
          context.logPath,
          `base64 still hit 413 or large file fallback (size=${stat.size}), splitting into ${CHUNK_DURATION_SEC}s chunks`,
        );
        text = null;
      }
    }

    if (text === null) {
      // Final fallback: chunk and transcribe sequentially.
      const chunkPaths = await splitWavIntoChunks(wavPath, context.jobDir, CHUNK_DURATION_SEC);
      if (chunkPaths.length === 0) throw new StageError('Could not split audio for transcription.', 'transcribing');
      appendLog(context.logPath, `split into ${chunkPaths.length} chunk(s), transcribing sequentially`);
      const parts = [];
      for (const chunkPath of chunkPaths) {
        appendLog(context.logPath, `transcribing chunk ${path.basename(chunkPath)}`);
        const chunkResp = await transcribeMultipart(chunkPath, apiKey, signal, context.logPath);
        const { text: chunkText } = await handleResponse(chunkResp);
        if (!chunkText)
          throw new StageError(
            `Transcription failed (HTTP ${chunkResp.status}).`,
            'transcribing',
            `empty chunk ${path.basename(chunkPath)}`,
          );
        parts.push(chunkText);
      }
      text = parts.join('\n\n');
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
    throw new StageError(
      error.name === 'AbortError' ? 'Transcription timed out.' : 'The transcription API could not be reached.',
      'transcribing',
      error.message,
    );
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { transcribe, MULTIPART_LIMIT, CHUNK_DURATION_SEC, splitWavIntoChunks, splitWavManual };
