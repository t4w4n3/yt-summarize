const path = require('node:path');
const { defineConfig } = require('@playwright/test');

// Runs the stack specs against the REAL container image (see
// e2e/compose.e2e.yaml) instead of host processes. The stack lifecycle is
// managed by `mise run test-containers` (podman-compose up before, down -v
// after) — there is deliberately no webServer or globalSetup here, because the
// stack is already running when this config starts.

const appUrl = `http://127.0.0.1:${process.env.E2E_PORT || 4174}`;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /stack\.spec\.js/,
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
});
