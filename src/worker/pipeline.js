const fs = require('node:fs');
const path = require('node:path');
const { config, STAGES, stageTimeoutMs } = require('../shared/constants');
const { updateStage, heartbeat, markDone } = require('../shared/db');
const { StageError } = require('./stages/process');
const { download } = require('./stages/download');
const { convert } = require('./stages/convert');
const { transcribe } = require('./stages/transcribe');
const { summarize } = require('./stages/summarize');

async function runPipeline(db, job, signal) {
  const jobDir = path.join(config.artifactsDir, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const logPath = path.join(jobDir, 'stage.log');
  const onHeartbeat = () => heartbeat(db, job.id);
  const context = { jobDir, logPath, onHeartbeat, timeoutMs: stageTimeoutMs('downloading'), signal };
  let audioPath;
  let wavPath;
  let transcriptPath;
  let currentStage = null;

  try {
    currentStage = STAGES[0];
    updateStage(db, job.id, currentStage, 5);
    const downloaded = await download(job, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    audioPath = downloaded.audioPath;

    currentStage = STAGES[1];
    updateStage(db, job.id, currentStage, 25);
    wavPath = await convert(audioPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });

    currentStage = STAGES[2];
    updateStage(db, job.id, currentStage, 45);
    transcriptPath = await transcribe(wavPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    try {
      fs.rmSync(audioPath, { force: true });
    } catch {}
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {}

    currentStage = STAGES[3];
    updateStage(db, job.id, currentStage, 70);
    const markdown = await summarize(transcriptPath, { ...context, timeoutMs: stageTimeoutMs(currentStage) });
    fs.writeFileSync(path.join(jobDir, 'summary.md'), `${markdown}\n`, 'utf8');
    markDone(db, job.id, downloaded.title, markdown);
  } catch (error) {
    error.stage = error.stage || currentStage;
    throw error;
  } finally {
    try {
      if (audioPath) fs.rmSync(audioPath, { force: true });
    } catch {}
    try {
      if (wavPath) fs.rmSync(wavPath, { force: true });
    } catch {}
  }
}

function friendlyError(error) {
  if (error instanceof StageError) {
    const detail = error.details ? ` ${error.details.slice(-600)}` : '';
    if (error.stage === 'downloading')
      return `YouTube could not provide this video. Check that it is public and the URL is correct.${detail}`;
    if (error.stage === 'transcribing' && error.message.includes('model is missing')) return error.message;
    if (error.stage === 'summarizing' && /credential|auth|api key|401|403/i.test(`${error.message} ${detail}`))
      return 'The summarizer could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.';
    return `${error.message}${detail}`;
  }
  return error?.message || 'The worker stopped unexpectedly.';
}

module.exports = { runPipeline, friendlyError };
