import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '../../application/config.ts';
import { friendlyError, stageOf } from '../../application/friendly-error.ts';
import type { PipelineDependencies, PipelineStages } from '../../application/pipeline-runner.ts';
import { runPipeline } from '../../application/pipeline-runner.ts';
import type { ArtifactStore } from '../../application/ports/artifact-store.ts';
import type { JobStore } from '../../application/ports/job-store.ts';
import type { Job } from '../../domain/job/entity.ts';
import { loadConfig } from '../../shared/config.ts';
import { createFilesystemArtifactStore } from '../outbound/filesystem/artifact-store.ts';
import { createSqliteJobStore, getJob } from '../outbound/sqlite/job-store.ts';
import { createPipelineStagePorts } from '../outbound/stages/stage-ports.ts';

export type SleepFn = (ms: number) => Promise<void>;

export type RunJobFn = (job: Job, dependencies: PipelineDependencies, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  db: DatabaseSync;
  /** JobStore port (defaults to the SQLite adapter over `db`). */
  store?: JobStore;
  pollMs: number;
  staleAfterMs: number;
  jobTimeoutMs: number;
  /** Artifact store port (defaults to the filesystem adapter from runtime config). */
  artifacts?: ArtifactStore;
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
  const runtimeConfig = opts.runtimeConfig ?? loadConfig(process.env);
  const store = opts.store ?? createSqliteJobStore(db);
  const artifacts = opts.artifacts ?? createFilesystemArtifactStore(runtimeConfig.artifactsDir);
  const stages = opts.stages ?? createPipelineStagePorts(undefined, runtimeConfig);
  const dependencies: PipelineDependencies = { jobStore: store, artifactStore: artifacts };
  const runJob: RunJobFn =
    opts.runJob ?? ((job, deps, signal) => runPipeline(job, deps, signal, stages, runtimeConfig));
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
        await runWithTimeout(() => runJob(job, dependencies, controller.signal), opts.jobTimeoutMs, controller);
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
