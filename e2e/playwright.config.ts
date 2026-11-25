import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Loaded by Playwright as native ESM (package "type": "module"), so
// import.meta.dirname is available — unlike CJS-transformed configs.

const dataDir = path.join(import.meta.dirname, '.tmp', 'data');
const appUrl = 'http://127.0.0.1:4174';
const workerHealthUrl = 'http://127.0.0.1:4175/healthz';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  outputDir: path.join(import.meta.dirname, '..', 'test-results'),
  use: {
    baseURL: appUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    // Never reuse a server that is already listening: a reused server would keep
    // its handle on a deleted SQLite file — the suite would then run against a
    // stale database. A busy port is a loud failure instead: kill the leftover
    // process and rerun.
    // Real app server (same code as the container, host process, temp data dir).
    // The wipe runs inside this command, BEFORE node starts: Playwright starts
    // webServers before any globalSetup, so a globalSetup wipe deletes behind
    // the servers' open fd — leftover rows (deduped 200 on first POST) and a
    // container-owned DB ("readonly database" writes) stay visible. Wiping here
    // guarantees a fresh, host-owned DB before either process opens it.
    {
      command: 'rm -rf e2e/.tmp/data && node src/infrastructure/inbound/http.ts',
      cwd: path.join(import.meta.dirname, '..'),
      url: appUrl,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { PORT: '4174', DATA_DIR: dataDir },
    },
    // Fake worker: simulates the 4-stage pipeline against the real SQLite DB.
    // No yt-dlp/ffmpeg/gpg/OpenRouter involved; canned title + Markdown out.
    {
      command: 'node e2e/fake-worker.ts',
      cwd: path.join(import.meta.dirname, '..'),
      url: workerHealthUrl,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { DATA_DIR: dataDir, FAKE_WORKER_PORT: '4175' },
    },
  ],
});
