/**
 * Integration tests at the runProcess subprocess boundary (src/worker/stages/process.ts).
 *
 * runProcess wraps child_process.spawn with timeout escalations (SIGTERM→SIGKILL),
 * output-size limits, heartbeat ticks and stage attribution. These are real
 * process launches (node -e as the bin), no mocks — the same riskiest control
 * flow in the worker (a regression here silently hangs or loses stage attribution).
 *
 * Category: integration — outbound adapter (real subprocess).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { runProcess, StageError } from '../../src/worker/stages/process.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proc-test-'));
}

describe('runProcess — subprocess boundary', () => {
  afterEach(() => {
    mock.restoreAll();
    process.env = { ...process.env };
  });

  it('resolves with stdout/stderr/code when the process exits 0', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("hello"); process.stderr.write("warn");'],
      { stage: 'downloading', timeoutMs: 5000 },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /warn/);
    assert.ok(result.durationMs >= 0);
  });

  it('rejects with StageError carrying the exit code and trailing detail when exit != 0', async () => {
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.stderr.write("boom\\nline2"); process.exit(3);'], {
        stage: 'converting',
        timeoutMs: 5000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StageError, 'must be a StageError');
        assert.ok(error instanceof Error);
        assert.equal(error.stage, 'converting');
        assert.match(error.message, /exit code 3/);
        assert.match(error.details, /boom/);
        return true;
      },
    );
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.exit(0);'], {
        stage: 'downloading',
        timeoutMs: 5000,
        signal: ac.signal,
      }),
      (error: unknown) =>
        error instanceof StageError && error.stage === 'downloading' && /cancelled/.test(error.message),
    );
  });

  it('rejects with the abort signal message and kills the child on mid-run abort', async () => {
    const ac = new AbortController();
    // A long-running child that ignores SIGTERM for a while; abort should reject
    // and record the cancellation. We abort shortly after spawn.
    const p = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000); process.stdout.write("running");'], {
      stage: 'transcribing',
      timeoutMs: 5000,
      signal: ac.signal,
    });
    // Give the child a moment to spawn, then abort.
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await assert.rejects(p, (error: unknown) => error instanceof StageError && /cancelled/.test(error.message));
  });

  it('rejects with a timeout StageError when the process exceeds timeoutMs', async () => {
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stage: 'downloading', timeoutMs: 150 }),
      (error: unknown) => {
        assert.ok(error instanceof StageError);
        assert.equal(error.stage, 'downloading');
        assert.match(error.message, /timed out/);
        return true;
      },
    );
  });

  it('rejects when the process produces too much output (output cap)', async () => {
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(26 * 1024 * 1024));'], {
        stage: 'downloading',
        timeoutMs: 5000,
      }),
      (error: unknown) => error instanceof StageError && /too much output/.test(error.message),
    );
  });

  it('settles only once the stage log stream is closed', async () => {
    // The caller deletes the job directory as soon as the promise settles, so a
    // log stream still opening in the background then fails with ENOENT as an
    // uncaught exception (a real flake in convert-download-boundary). Track the
    // stream's close event to observe the ordering deterministically.
    const dir = tmpDir();
    const logPath = path.join(dir, 'stage.log');
    const closed: string[] = [];
    const createWriteStream = fs.createWriteStream.bind(fs);
    mock.method(fs, 'createWriteStream', (file: fs.PathLike, options?: Parameters<typeof fs.createWriteStream>[1]) => {
      const stream = createWriteStream(file, options);
      stream.on('close', () => closed.push(file.toString()));
      return stream;
    });
    try {
      const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi");'], {
        stage: 'downloading',
        timeoutMs: 5000,
        logPath,
      });
      assert.equal(result.code, 0);
      assert.deepEqual(
        closed,
        [logPath],
        'stage.log must be closed by the time runProcess settles, otherwise the caller can delete the job dir under an open stream',
      );
    } finally {
      mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a stage log that cannot be opened', async () => {
    const dir = tmpDir();
    // The parent directory does not exist, so opening the log fails with ENOENT.
    const logPath = path.join(dir, 'gone', 'stage.log');
    try {
      const started = Date.now();
      const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi");'], {
        stage: 'downloading',
        timeoutMs: 5000,
        logPath,
      });
      const elapsedMs = Date.now() - started;
      assert.equal(result.code, 0);
      assert.equal(fs.existsSync(logPath), false);
      // A log that never opened can never close: waiting for it would stall the
      // stage for the whole LOG_CLOSE_TIMEOUT_MS bound (5 s) on every job.
      assert.ok(elapsedMs < 2000, `a broken stage log must not stall the stage, took ${elapsedMs}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with a could-not-start StageError when the binary is missing', async () => {
    await assert.rejects(
      runProcess('/nonexistent/binary-xyz', ['arg'], { stage: 'converting', timeoutMs: 5000 }),
      (error: unknown) =>
        error instanceof StageError && /could not start/.test(error.message) && error.stage === 'converting',
    );
  });
});
