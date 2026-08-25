import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// Hermetic UI tests: the API is mocked with page.route, and the page clock is
// used to drive the app's 2-second polling deterministically. No real backend
// state is involved, so these tests are fast and repeatable.

const JOB_ID = 'e2e00000-0000-4000-8000-000000000000';
const VALID_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const RESULT = {
  title: 'The real e2e video',
  markdown: ['## Overview', '', 'A test overview paragraph.', '', '## Key Takeaways', '', '- One', '- Two', ''].join(
    '\n',
  ),
  wordCount: 14,
};

interface JobMockOptions {
  jobStates?: Array<Record<string, unknown>>;
  createError?: { status: number; error: string };
}

function installJobMock(page: Page, { jobStates = [], createError }: JobMockOptions) {
  let pollIndex = 0;
  let posts = 0;
  const bodies: Array<Record<string, unknown>> = [];
  page.route('**/api/summarize', (route) => {
    posts += 1;
    try {
      const parsed = route.request().postDataJSON();
      if (parsed && typeof parsed === 'object') bodies.push(parsed as Record<string, unknown>);
    } catch {}
    if (createError) {
      return route.fulfill({
        status: createError.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: createError.error }),
      });
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ jobId: JOB_ID }) });
  });
  page.route(`**/api/jobs/${JOB_ID}`, (route) => {
    const state = jobStates[Math.min(pollIndex, jobStates.length - 1)] ?? {};
    pollIndex += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
  });
  page.route(`**/api/jobs/${JOB_ID}/result`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULT) }),
  );
  return { posts: () => posts, bodies: () => bodies };
}

async function gotoWithClock(page: Page) {
  await page.clock.install();
  await page.goto('/');
}

const STAGE_STEPS = ['downloading', 'converting', 'transcribing', 'summarizing'];

test('shell renders the workstation surface', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Summarize YT/);
  const favicon = await request.get('/favicon.svg');
  expect(favicon.status()).toBe(200);
  await expect(page.locator('#summarize-form')).toBeVisible();
  await expect(page.locator('#submit-button')).toHaveText(/SUMMARIZE/);
  await expect(page.locator('.pipeline-step')).toHaveCount(4);
  await expect(page.locator('#note-empty')).toBeVisible();
  await expect(page.locator('#footer-state')).toHaveText('IDLE');
  await expect(page.locator('#word-count')).toHaveText('NO WORDS');
  await expect(page.locator('#status-message')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#url-error')).toBeHidden();
});

test('rejects non-YouTube URLs before any request is sent', async ({ page }) => {
  const mocks = installJobMock(page, { jobStates: [] });
  await page.goto('/');
  const badUrls = [
    'not a url',
    'https://example.com/video',
    'youtube.com/watch?v=abc', // no scheme
    'https://youtu.be/', // no video id
    'https://www.youtube.com/playlist?list=PL123', // not a watch URL
  ];
  for (const bad of badUrls) {
    await page.fill('#video-url', bad);
    await page.click('#submit-button');
    await expect(page.locator('#url-error')).toBeVisible();
    await expect(page.locator('#video-url')).toHaveAttribute('aria-invalid', 'true');
  }
  expect(mocks.posts()).toBe(0);
});

test('walks a job through all four stages to a rendered note', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, {
    jobStates: [
      { status: 'queued' },
      { status: 'running', stage: 'downloading', progress: 25 },
      { status: 'running', stage: 'converting', progress: 50 },
      { status: 'running', stage: 'transcribing', progress: 75 },
      { status: 'running', stage: 'summarizing', progress: 100 },
      { status: 'done' },
    ],
  });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');

  await expect(page.locator('#queue-state')).toHaveText('1 QUEUED');
  await expect(page.locator('#footer-state')).toHaveText('QUEUED');
  await expect(page.locator('#output-loading')).toBeVisible();

  for (const [index, stage] of STAGE_STEPS.entries()) {
    await page.clock.fastForward(2000);
    const step = page.locator(`.pipeline-step[data-stage="${stage}"]`);
    await expect(step).toHaveClass(/is-active/);
    await expect(page.locator('#status-message')).toHaveText(new RegExp(stage.toUpperCase()));
    if (index > 0) {
      await expect(page.locator(`.pipeline-step[data-stage="${STAGE_STEPS[index - 1]}"]`)).toHaveClass(/is-done/);
    }
  }

  await page.clock.fastForward(2000); // final poll → done
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-title')).toHaveText(RESULT.title);
  await expect(page.locator('#output-subtitle')).toHaveText('READY · rendered Markdown');
  await expect(page.locator('#footer-state')).toHaveText('DONE');
  await expect(page.locator('#queue-state')).toHaveText('COMPLETE');
  await expect(page.locator('#word-count')).toHaveText(`${RESULT.wordCount} WORDS`);
  await expect(page.locator('#markdown-output h2').first()).toHaveText('Overview');
  await expect(page.locator('#download-button')).toBeVisible();
  for (const stage of STAGE_STEPS) {
    await expect(page.locator(`.pipeline-step[data-stage="${stage}"]`)).toHaveClass(/is-done/);
  }
});

test('surfaces a failed job and offers a reset', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, {
    jobStates: [{ status: 'failed', error: 'YouTube said: Sign in to confirm you are not a bot.' }],
  });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');
  await expect(page.locator('#output-error')).toBeVisible();
  await expect(page.locator('#output-error-copy')).toContainText('Sign in to confirm');
  await expect(page.locator('#footer-state')).toHaveText('ERROR');
  await expect(page.locator('#queue-state')).toHaveText('FAILED');
  // Failed jobs release the form so the user can retry immediately.
  await expect(page.locator('#video-url')).toBeEnabled();

  await page.click('#output-error [data-action="reset"]');
  await expect(page.locator('#note-empty')).toBeVisible();
  await expect(page.locator('#video-url')).toHaveValue('');
  await expect(page.locator('#video-url')).toBeEnabled();
  await expect(page.locator('#footer-state')).toHaveText('IDLE');
});

test('shows the server error when job creation is rejected', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, {
    jobStates: [],
    createError: { status: 400, error: 'Only youtube.com and youtu.be video URLs are supported.' },
  });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');
  await expect(page.locator('#output-error')).toBeVisible();
  await expect(page.locator('#output-error-copy')).toHaveText(
    'Only youtube.com and youtu.be video URLs are supported.',
  );
  await expect(page.locator('#footer-state')).toHaveText('ERROR');
});

test('sample note opens, downloads, and resets via Escape', async ({ page }) => {
  await page.goto('/');
  await page.click('#sample-button');
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-title')).toHaveText('How to make a note worth keeping');
  await expect(page.locator('#footer-state')).toHaveText('SAMPLE');
  await expect(page.locator('#word-count')).toHaveText(/\d+ WORDS/);
  await expect(page.locator('#markdown-output h2').first()).toHaveText('Overview');
  await expect(page.locator('#toast')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#download-button');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  expect(fs.readFileSync(await download.path(), 'utf8')).toContain('## Overview');

  const shortcutDownload = page.waitForEvent('download');
  await page.keyboard.press('Control+d');
  expect((await shortcutDownload).suggestedFilename()).toMatch(/\.md$/);

  await page.keyboard.press('Escape');
  await expect(page.locator('#note-empty')).toBeVisible();
  await expect(page.locator('#footer-state')).toHaveText('IDLE');
});

test('Escape cancels an in-flight job and restores the empty state', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, { jobStates: [{ status: 'running', stage: 'downloading' }] });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');
  await expect(page.locator('.pipeline-step[data-stage="downloading"]')).toHaveClass(/is-active/);
  await expect(page.locator('#video-url')).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(page.locator('#note-empty')).toBeVisible();
  await expect(page.locator('#video-url')).toHaveValue('');
  await expect(page.locator('#video-url')).toBeEnabled();
  await expect(page.locator('#footer-state')).toHaveText('IDLE');
});

test('mobile layout keeps the form usable with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#video-url')).toBeVisible();
  await expect(page.locator('#submit-button')).toBeVisible();
  await expect(page.locator('.pipeline-step')).toHaveCount(4);
  const overflow = await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1');
  expect(overflow).toBe(false);
});

test.describe('note language for English browsers', () => {
  test.use({ locale: 'en-US' });

  test('no picker is shown and no lang field is sent', async ({ page }) => {
    const mocks = installJobMock(page, { jobStates: [{ status: 'queued' }] });
    await page.goto('/');
    await expect(page.locator('#output-lang-row')).toBeHidden();
    await page.fill('#video-url', VALID_URL);
    await page.click('#submit-button');
    await expect(page.locator('#output-loading')).toBeVisible();
    expect(mocks.bodies()[0]?.lang).toBeUndefined();
  });
});

test.describe('note language picker (non-English browser)', () => {
  test.use({ locale: 'fr-FR' });

  test('defaults to the browser locale and sends it with the job', async ({ page }) => {
    const mocks = installJobMock(page, { jobStates: [{ status: 'queued' }] });
    await page.goto('/');
    await expect(page.locator('#output-lang-row')).toBeVisible();
    const options = page.locator('#output-lang option');
    await expect(options).toHaveCount(2);
    await expect(options.first()).toHaveText(/français/i);
    await expect(options.nth(1)).toHaveAttribute('value', 'en');
    await page.fill('#video-url', VALID_URL);
    await page.click('#submit-button');
    await expect(page.locator('#output-loading')).toBeVisible();
    expect(mocks.bodies()[0]?.lang).toBe('fr');
  });

  test('sends English when explicitly selected', async ({ page }) => {
    const mocks = installJobMock(page, { jobStates: [{ status: 'queued' }] });
    await page.goto('/');
    await page.selectOption('#output-lang', 'en');
    await page.fill('#video-url', VALID_URL);
    await page.click('#submit-button');
    await expect(page.locator('#output-loading')).toBeVisible();
    expect(mocks.bodies()[0]?.lang).toBe('en');
  });
});
