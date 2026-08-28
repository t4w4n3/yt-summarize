import { config } from '../shared/config.ts';
import { closeDatabase, openDatabase } from '../shared/db.ts';
import { createWorker } from './worker-core.ts';

const db = openDatabase();
const worker = createWorker({
  db,
  pollMs: config.pollMs,
  staleAfterMs: config.staleAfterMs,
  jobTimeoutMs: config.jobTimeoutMs,
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
