const path = require('node:path');

const STAGES = Object.freeze(['downloading', 'converting', 'transcribing', 'summarizing']);
const STATUS = Object.freeze({ QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed' });

const config = Object.freeze({
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || '/data',
  artifactsDir: process.env.ARTIFACTS_DIR || '/artifacts',
  sttModel: process.env.STT_MODEL || 'mistralai/voxtral-mini-transcribe',
  llmProvider: process.env.LLM_PROVIDER || 'openrouter',
  llmModel: process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash-0731',
  llmThinking: process.env.LLM_THINKING || 'high',
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 1800000),
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 600000),
});

function dbPath() {
  return path.join(config.dataDir, 'jobs.db');
}

function stageTimeoutMs(stage) {
  return {
    downloading: 10 * 60 * 1000,
    converting: 15 * 60 * 1000,
    transcribing: 25 * 60 * 1000,
    summarizing: 10 * 60 * 1000,
  }[stage] || config.jobTimeoutMs;
}

module.exports = { STAGES, STATUS, config, dbPath, stageTimeoutMs };
