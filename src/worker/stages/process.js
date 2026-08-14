const { spawn } = require('node:child_process');
const fs = require('node:fs');

class StageError extends Error {
  constructor(message, stage, details = '') {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    this.details = details;
  }
}

function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 600000, logPath, inputPath, stage = 'pipeline', onHeartbeat, signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new StageError(`${stage} was cancelled.`, stage));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const started = Date.now();
    const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      signal?.removeEventListener('abort', onAbort);
      log?.end();
      fn(value);
    };
    const heartbeatTimer = setInterval(() => onHeartbeat?.(), 10000);
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      finish(reject, new StageError(`${stage} timed out after ${Math.round(timeoutMs / 60000)} minutes.`, stage));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      finish(reject, new StageError(`${stage} was cancelled.`, stage));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    log?.write(`\n$ ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`);
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 25 * 1024 * 1024) {
        child.kill('SIGTERM');
        finish(reject, new StageError(`${stage} produced too much output.`, stage));
      }
      log?.write(text);
    });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; log?.write(text); });
    child.on('error', error => finish(reject, new StageError(`${stage} could not start: ${error.message}`, stage)));
    child.on('close', (code, signal) => {
      if (settled) return;
      const result = { code, signal, stdout, stderr, durationMs: Date.now() - started };
      if (code === 0) return finish(resolve, result);
      const detail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
      finish(reject, new StageError(`${stage} failed${code == null ? ` (${signal || 'terminated'})` : ` with exit code ${code}`}.`, stage, detail));
    });

    if (inputPath) {
      const input = fs.createReadStream(inputPath);
      input.on('error', error => { child.stdin.destroy(error); });
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

module.exports = { StageError, runProcess };
