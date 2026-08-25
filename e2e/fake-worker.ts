// Fake pipeline worker for e2e tests.
// Reuses the real job store (src/shared/db.ts) and walks each claimed job
// through the same 4 stages the container worker would, then marks it done
// with canned output. No yt-dlp, ffmpeg, gpg, or OpenRouter involved.
//
// Env:
//   DATA_DIR          shared with the app server (same SQLite DB)
//   FAKE_WORKER_PORT  health-check HTTP port (default 4175)
//   FAKE_STAGE_DELAY_MS  per-stage delay (default 250)
//   FAKE_POLL_MS      claim loop interval (default 150)

import http from 'node:http';
import { STAGES } from '../src/shared/constants.ts';
import { claimNextJob, heartbeat, markDone, markFailed, openDatabase, updateStage } from '../src/shared/db.ts';

const HEALTH_PORT = Number(process.env.FAKE_WORKER_PORT || 4175);
const STAGE_DELAY_MS = Number(process.env.FAKE_STAGE_DELAY_MS || 250);
const POLL_MS = Number(process.env.FAKE_POLL_MS || 150);

const TITLE = 'Me at the zoo (e2e fixture)';
const MARKDOWN = [
  '## Overview',
  '',
  'An end-to-end fixture video about the world\u2019s first upload. This note proves the full job lifecycle works against the real API and database without touching YouTube or the paid model APIs.',
  '',
  '## Key Takeaways',
  '',
  '- The pipeline runs download \u2192 convert \u2192 transcribe \u2192 summarize in order.',
  '- Status and stage updates are visible to the browser while the job runs.',
  '- The final Markdown is served by the API and rendered by the UI.',
  '',
  '## Core Concepts',
  '',
  '**End-to-end testing** exercises the real HTTP contract and job store with a simulated pipeline.',
  '',
  '## Action Items',
  '',
  '- Run `npm run test:e2e` after any change to the API or UI.',
  '',
].join('\n');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const db = openDatabase();

http
  .createServer((req, res) => {
    if (req.url === '/healthz') return res.writeHead(200).end('ok');
    res.writeHead(404).end();
    return;
  })
  .listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[fake-worker] health check on :${HEALTH_PORT}`);
  });

async function run(): Promise<void> {
  for (;;) {
    const job = claimNextJob(db);
    if (job) {
      try {
        for (const [index, stage] of STAGES.entries()) {
          updateStage(db, job.id, stage, Math.round(((index + 1) / STAGES.length) * 100));
          heartbeat(db, job.id);
          await delay(STAGE_DELAY_MS);
        }
        markDone(db, job.id, TITLE, MARKDOWN);
        console.log(`[fake-worker] completed ${job.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markFailed(db, job.id, message, 'pipeline');
        console.error(`[fake-worker] failed ${job.id}: ${message}`);
      }
    }
    await delay(POLL_MS);
  }
}

run();

function shutdown(): void {
  console.log('[fake-worker] shutting down');
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
