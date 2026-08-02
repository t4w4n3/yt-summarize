const path = require('node:path');
const { defineConfig } = require('@playwright/test');

const dataDir = path.join(__dirname, '.tmp', 'data');
const appUrl = 'http://127.0.0.1:4174';
const workerHealthUrl = 'http://127.0.0.1:4175/healthz';

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  globalSetup: path.join(__dirname, 'global-setup.js'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  outputDir: path.join(__dirname, '..', 'test-results'),
  use: {
    baseURL: appUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    // Real app server (same code as the container, host process, temp data dir).
    {
      command: 'node src/app/server.js',
      cwd: path.join(__dirname, '..'),
      url: appUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { PORT: '4174', DATA_DIR: dataDir },
    },
    // Fake worker: simulates the 4-stage pipeline against the real SQLite DB.
    // No yt-dlp/ffmpeg/gpg/OpenRouter involved; canned title + Markdown out.
    {
      command: 'node e2e/fake-worker.js',
      cwd: path.join(__dirname, '..'),
      url: workerHealthUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { DATA_DIR: dataDir, FAKE_WORKER_PORT: '4175' },
    },
  ],
});
