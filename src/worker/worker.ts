import { config } from '../shared/config.ts';
import {
  claimNextJob,
  closeDatabase,
  getJob,
  heartbeat,
  markFailed,
  openDatabase,
  reclaimStaleJobs,
} from '../shared/db.ts';
import { friendlyError, runPipeline, stageOf } from './pipeline.ts';

const db = openDatabase();
let stopping = false;

async function loop(): Promise<void> {
  console.log(`Worker ready; polling every ${config.pollMs}ms`);
  while (!stopping) {
    try {
      const reclaimed = reclaimStaleJobs(db, config.staleAfterMs);
      if (reclaimed) console.log(`Re-queued ${reclaimed} stale job(s)`);
      const job = claimNextJob(db);
      if (!job) {
        await sleep(config.pollMs);
        continue;
      }
      console.log(`Starting ${job.id}`);
      const controller = new AbortController();
      const beat = setInterval(() => heartbeat(db, job.id), 10000);
      try {
        await runWithTimeout(() => runPipeline(db, job, controller.signal), config.jobTimeoutMs, controller);
        console.log(`Completed ${job.id}`);
      } catch (error) {
        console.error(`Failed ${job.id}:`, error);
        // The claimed row carries stage=NULL; attribute the failure to the
        // stage the job was actually in when it stopped.
        const current = getJob(db, job.id);
        markFailed(db, job.id, friendlyError(error), stageOf(error) || current?.stage || job.stage);
      } finally {
        clearInterval(beat);
        controller.abort();
      }
    } catch (error) {
      console.error('Worker loop error:', error);
      await sleep(Math.max(config.pollMs, 2000));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWithTimeout(task: () => Promise<void>, timeoutMs: number, controller: AbortController): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
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

function shutdown(signal: string): void {
  console.log(`${signal}: worker shutting down`);
  stopping = true;
  closeDatabase(db);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
loop().catch((error) => {
  console.error(error);
  closeDatabase(db);
  process.exit(1);
});
