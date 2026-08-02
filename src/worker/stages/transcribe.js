const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../../shared/constants');
const { StageError } = require('./process');
const { resolveOpenRouterKey } = require('./openrouter');

const API_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

function appendLog(logPath, line) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, `${line}\n`, 'utf8'); } catch {}
}

async function transcribe(wavPath, context) {
  const apiKey = await resolveOpenRouterKey();
  const audio = await fs.promises.readFile(wavPath);
  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');

  const controller = new AbortController();
  const timeoutMs = context.timeoutMs || 25 * 60 * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    appendLog(context.logPath, `$ POST ${API_URL} (model=${config.sttModel}, file=${path.basename(wavPath)})`);
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    throw new StageError(
      error.name === 'AbortError' ? 'Transcription timed out.' : 'The transcription API could not be reached.',
      'transcribing',
      error.message,
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!response.ok || !text) {
    throw new StageError(`Transcription failed (HTTP ${response.status}).`, 'transcribing', JSON.stringify(body).slice(0, 1000));
  }

  const transcriptPath = path.join(context.jobDir, 'transcript.txt');
  fs.writeFileSync(transcriptPath, `${text}\n`, 'utf8');
  appendLog(context.logPath, `transcript.txt: ${text.split(/\s+/).length} words`);
  return transcriptPath;
}

module.exports = { transcribe };
