import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '../application/config.ts';
import type { JobStore } from '../application/ports/job-store.ts';
import type { Job } from '../domain/job/entity.ts';
import { createSqliteJobStore, getJob } from '../infrastructure/outbound/sqlite/job-store.ts';
import { createPipelineStagePorts } from '../infrastructure/outbound/stages/stage-ports.ts';
import type { PipelineStages } from './pipeline.ts';
import { friendlyError, runPipeline, stageOf } from './pipeline.ts';

export type SleepFn = (ms: number) => Promise<void>;

export type RunJobFn = (db: DatabaseSync, job: Job, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  db: DatabaseSync;
  /** JobStore port (defaults to the SQLite adapter over `db`). */
  store?: JobStore;
  pollMs: number;
  staleAfterMs: number;
  jobTimeoutMs: number;
  /** Stage ports used by the default pipeline (defaults to real adapters). */
  stages?: PipelineStages;
  /** Runtime settings threaded into the default pipeline. */
  runtimeConfig?: RuntimeConfig;
  /** Injected pipeline runner (defaults to the real runPipeline). */
  runJob?: RunJobFn;
  /** Injected sleeper (defaults to a real timer). Tests substitute an instant sleep. */
  sleep?: SleepFn;
}

export interface Worker {
  /** Runs a single claim/reclaim/run iteration. Returns true if a job ran. */
  runOnce(): Promise<boolean>;
  /** Runs the polling loop until stop() is called; resolves when it exits. */
  start(): Promise<void>;
  /** Signals the loop to stop after the current iteration. */
  stop(): void;
}

const HEARTBEAT_MS = 10_000;

export function createWorker(opts: WorkerOptions): Worker {
  const { db } = opts;
  const store = opts.store ?? createSqliteJobStore(db);
  const stages = opts.stages ?? createPipelineStagePorts(undefined, opts.runtimeConfig);
  const runJob: RunJobFn = opts.runJob ?? ((d, job, signal) => runPipeline(d, job, signal, stages, opts.runtimeConfig));
  const sleep: SleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let stopping = false;

  async function runOnce(): Promise<boolean> {
    try {
      const reclaimed = store.reclaimStaleJobs(opts.staleAfterMs);
      if (reclaimed) console.log(`Re-queued ${reclaimed} stale job(s)`);

      const claimedJob = store.claimNext();
      if (!claimedJob) {
        await sleep(opts.pollMs);
        return false;
      }
      const job = getJob(db, claimedJob.id);
      if (!job) {
        await sleep(opts.pollMs);
        return false;
      }

      console.log(`Starting ${job.id}`);
      const controller = new AbortController();
      const beat = setInterval(() => store.heartbeat(job.id), HEARTBEAT_MS);
      try {
        await runWithTimeout(() => runJob(db, job, controller.signal), opts.jobTimeoutMs, controller);
        console.log(`Completed ${job.id}`);
      } catch (error) {
        console.error(`Failed ${job.id}:`, error);
        // The claimed row carries stage=NULL; attribute the failure to the
        // stage the job was actually in when it stopped.
        const current = store.get(job.id);
        store.markFailed(job.id, friendlyError(error), stageOf(error) || current?.stage || job.stage);
      } finally {
        clearInterval(beat);
        controller.abort();
      }
      return true;
    } catch (error) {
      console.error('Worker loop error:', error);
      await sleep(Math.max(opts.pollMs, 2000));
      return false;
    }
  }

  return {
    runOnce,
    async start() {
      console.log(`Worker ready; polling every ${opts.pollMs}ms`);
      while (!stopping) {
        await runOnce();
      }
    },
    stop() {
      stopping = true;
    },
  };
}

export function runWithTimeout(
  task: () => Promise<void>,
  timeoutMs: number,
  controller: AbortController,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Abort the in-flight pipeline (kills child processes / aborts fetches)
      // so the job is actually stopped, not merely reported as failed.
      controller.abort();
      reject(new Error(`Job exceeded the ${Math.round(timeoutMs / 60000)} minute limit.`));
    }, timeoutMs);
  });
  return Promise.race([task(), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
