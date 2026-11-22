import { closeDatabase, createSqliteJobStore, openDatabase } from '../infrastructure/outbound/sqlite/job-store.ts';
import { createPipelineStagePorts } from '../infrastructure/outbound/stages/stage-ports.ts';
import { loadConfig } from '../shared/config.ts';
import { createWorker } from './worker-core.ts';

const runtimeConfig = loadConfig(process.env);
const stagePorts = createPipelineStagePorts(undefined, runtimeConfig);
const db = openDatabase();
const store = createSqliteJobStore(db);
const worker = createWorker({
  db,
  store,
  pollMs: runtimeConfig.pollMs,
  staleAfterMs: runtimeConfig.staleAfterMs,
  jobTimeoutMs: runtimeConfig.jobTimeoutMs,
  stages: stagePorts,
  runtimeConfig,
});

void worker.start().catch((error) => {
  console.error(error);
  closeDatabase(db);
  process.exit(1);
});

function shutdown(signal: string): void {
  console.log(`${signal}: worker shutting down`);
  worker.stop();
  closeDatabase(db);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
