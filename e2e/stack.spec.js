const { test, expect } = require('@playwright/test');

// Full-stack contract tests: real app server + fake worker + real SQLite DB.
// Jobs run through the actual queue; the browser test drives the real UI with
// real polling. Serial mode keeps the single-queue worker deterministic.

test.describe.configure({ mode: 'serial' });

const VALID_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

test('API contract: validation, lifecycle, result, download', async ({ request }) => {
  // Server-side validation
  for (const bad of [
    'https://example.com/video',
    'https://youtu.be/',
    'not a url',
    'https://user:pass@www.youtube.com/watch?v=jNQXAC9IVRw',
  ]) {
    const res = await request.post('/api/summarize', { data: { url: bad } });
    expect(res.status(), `expected 400 for ${bad}`).toBe(400);
  }
  const noBody = await request.post('/api/summarize', { data: {} });
  expect(noBody.status()).toBe(400);

  // Create a job
  const created = await request.post('/api/summarize', { data: { url: VALID_URL } });
  expect(created.status()).toBe(201);
  const { jobId } = await created.json();
  expect(jobId).toBeTruthy();

  // Lifecycle: queued → running → done (fake worker completes it)
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/jobs/${jobId}`);
        return (await res.json()).status;
      },
      { timeout: 30_000 },
    )
    .toBe('done');

  // Result
  const resultRes = await request.get(`/api/jobs/${jobId}/result`);
  expect(resultRes.status()).toBe(200);
  const result = await resultRes.json();
  expect(result.title).toBeTruthy();
  expect(result.markdown).toContain('## ');
  expect(result.wordCount).toBeGreaterThan(0);

  // .md download endpoint
  const mdRes = await request.get(`/api/jobs/${jobId}/result.md`);
  expect(mdRes.status()).toBe(200);
  expect(mdRes.headers()['content-type']).toContain('text/markdown');
  expect(mdRes.headers()['content-disposition']).toContain('attachment');
  expect(await mdRes.text()).toContain('## ');

  // Unknown job
  expect((await request.get('/api/jobs/does-not-exist')).status()).toBe(404);
});

test('browser: full flow against the real stack', async ({ page }) => {
  await page.goto('/');
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');

  // Real 2s polling + fake worker (~1s of stage delays): give it room.
  await expect(page.locator('#note-content')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#footer-state')).toHaveText('DONE');
  await expect(page.locator('#queue-state')).toHaveText('COMPLETE');
  await expect(page.locator('#note-title')).toHaveText('Me at the zoo (e2e fixture)');
  await expect(page.locator('#markdown-output h2').first()).toHaveText('Overview');
  await expect(page.locator('#word-count')).toHaveText(/\d+ WORDS/);

  for (const stage of ['downloading', 'converting', 'transcribing', 'summarizing']) {
    await expect(page.locator(`.pipeline-step[data-stage="${stage}"]`)).toHaveClass(/is-done/);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.click('#download-button');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^me-at-the-zoo.*\.md$/);
});
