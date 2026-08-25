import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Error carrying the pipeline stage that produced it, for friendly mapping. */
export class StageError extends Error {
  stage: string;
  details: string;

  constructor(message: string, stage: string, details = '') {
    super(message);
    this.name = 'StageError';
    this.stage = stage;
    this.details = details;
  }
}

/**
 * Per-stage inputs shared by every pipeline stage. `jobDir` and `logPath`
 * are always provided by the pipeline; `signal` carries job cancellation,
 * `onHeartbeat` keeps the SQLite lease alive during long subprocesses.
 */
export interface StageContext {
  jobDir: string;
  logPath: string;
  onHeartbeat?: () => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  logPath?: string;
  inputPath?: string;
  stage?: string;
  onHeartbeat?: () => void;
  signal?: AbortSignal;
}

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const { cwd, env, timeoutMs = 600000, logPath, inputPath, stage = 'pipeline', onHeartbeat, signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new StageError(`${stage} was cancelled.`, stage));
  }
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const started = Date.now();
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
    const finish = ((fn: (value: never) => void, value: never) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      signal?.removeEventListener('abort', onAbort);
      log?.end();
      fn(value);
    }) as unknown as {
      (fn: (value: ProcessResult) => void, value: ProcessResult): void;
      (fn: (error: Error) => void, error: Error): void;
    };
    heartbeatTimer = setInterval(() => onHeartbeat?.(), 10000);
    timeout = setTimeout(() => {
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

    log?.write(`\n$ ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}\n`);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 25 * 1024 * 1024) {
        child.kill('SIGTERM');
        finish(reject, new StageError(`${stage} produced too much output.`, stage));
      }
      log?.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      log?.write(chunk.toString());
    });
    child.on('error', (error: Error) =>
      finish(reject, new StageError(`${stage} could not start: ${error.message}`, stage)),
    );
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      const result: ProcessResult = { code, signal: exitSignal, stdout, stderr, durationMs: Date.now() - started };
      if (code === 0) return finish(resolve, result);
      const detail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
      finish(
        reject,
        new StageError(
          `${stage} failed${code == null ? ` (${exitSignal || 'terminated'})` : ` with exit code ${code}`}.`,
          stage,
          detail,
        ),
      );
    });

    if (inputPath) {
      const input = fs.createReadStream(inputPath);
      input.on('error', (error) => {
        child.stdin.destroy(error);
      });
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}
