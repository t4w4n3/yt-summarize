const { config } = require('../shared/constants');
const { openDatabase, claimNextJob, reclaimStaleJobs, heartbeat, markFailed, closeDatabase } = require('../shared/db');
const { runPipeline, friendlyError } = require('./pipeline');

const db = openDatabase();
let stopping = false;

async function loop() {
  console.log(`Worker ready; polling every ${config.pollMs}ms`);
  while (!stopping) {
    try {
      const reclaimed = reclaimStaleJobs(db, config.staleAfterMs);
      if (reclaimed) console.log(`Re-queued ${reclaimed} stale job(s)`);
      const job = claimNextJob(db);
      if (!job) { await sleep(config.pollMs); continue; }
      console.log(`Starting ${job.id}`);
      const beat = setInterval(() => heartbeat(db, job.id), 10000);
      try {
        await runWithTimeout(() => runPipeline(db, job), config.jobTimeoutMs);
        console.log(`Completed ${job.id}`);
      } catch (error) {
        console.error(`Failed ${job.id}:`, error);
        markFailed(db, job.id, friendlyError(error), error.stage || job.stage);
      } finally {
        clearInterval(beat);
      }
    } catch (error) {
      console.error('Worker loop error:', error);
      await sleep(Math.max(config.pollMs, 2000));
    }
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function runWithTimeout(task, timeoutMs) {
  return Promise.race([
    task(),
    new Promise((_, reject) => setTimeout(() => { const error = new Error(`Job exceeded the ${Math.round(timeoutMs / 60000)} minute limit.`); error.stage = 'summarizing'; reject(error); }, timeoutMs)),
  ]);
}
function shutdown(signal) {
  console.log(`${signal}: worker shutting down`);
  stopping = true;
  closeDatabase(db);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
loop().catch(error => { console.error(error); closeDatabase(db); process.exit(1); });
