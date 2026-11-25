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
  markdown: [
    '## Overview',
    '',
    'A test overview paragraph.',
    '',
    '### A nested detail',
    '',
    'A test detail paragraph.',
    '',
    '## Key Takeaways',
    '',
    '- One',
    '- Two',
    '',
  ].join('\n'),
  wordCount: 14,
};

interface JobMockOptions {
  jobStates?: Array<Record<string, unknown>>;
  statusResponses?: Array<{ status: number; body: Record<string, unknown> }>;
  createError?: { status: number; error: string };
  historyJobs?: Array<Record<string, unknown>>;
}

function installJobMock(
  page: Page,
  { jobStates = [], statusResponses = [], createError, historyJobs = [] }: JobMockOptions,
) {
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
    const response = statusResponses[pollIndex];
    const stateIndex = pollIndex - statusResponses.length;
    pollIndex += 1;
    if (response) {
      return route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    }
    const state = jobStates[Math.min(stateIndex, jobStates.length - 1)] ?? {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
  });
  page.route(`**/api/jobs/${JOB_ID}/result`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULT) }),
  );
  page.route(/\/api\/jobs(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const jobs = q
      ? historyJobs.filter((j) =>
          String(j.title ?? '')
            .toLowerCase()
            .includes(q),
        )
      : historyJobs;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs }) });
  });
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
  await expect(page.locator('#status-message')).toHaveText(/READY/);
  await expect(page.locator('#word-count')).toHaveText('NO WORDS');
  await expect(page.locator('.menu-item')).toHaveCount(0);
  await expect(page.locator('#sample-button')).toHaveCount(0);
  await expect(page.locator('.desktop-note')).toHaveCount(0);
  await expect(page.locator('#history-search')).toBeVisible();
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

  await expect(page.locator('#status-message')).toHaveText(/QUEUED/);
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
  await expect(page.locator('#note-empty')).toBeHidden();
  await expect(page.locator('#note-title')).toHaveText(RESULT.title);
  await expect(page.locator('#output-subtitle')).toHaveText('READY · rendered Markdown');
  await expect(page.locator('#status-message')).toHaveText(/DONE/);
  await expect(page.locator('#word-count')).toHaveText(`${RESULT.wordCount} WORDS`);
  await expect(page.locator('#markdown-output h2').first()).toHaveText('Overview');
  await expect(page.locator('#markdown-output h3').first()).toHaveText('A nested detail');
  await expect(page.locator('#download-button')).toBeVisible();
  for (const stage of STAGE_STEPS) {
    await expect(page.locator(`.pipeline-step[data-stage="${stage}"]`)).toHaveClass(/is-done/);
  }
});

test('retries transient status failures without abandoning the job', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, {
    statusResponses: [{ status: 503, body: { error: 'Temporary status outage.' } }],
    jobStates: [{ status: 'queued' }, { status: 'done' }],
  });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');

  await expect(page.locator('#output-error')).toBeHidden();
  await expect(page.locator('#output-loading')).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(page.locator('#status-message')).toHaveText(/QUEUED/);
  await page.clock.fastForward(2000);
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#status-message')).toHaveText(/DONE/);
});

test('keeps a resume pointer after a transient status failure', async ({ page }) => {
  await page.addInitScript((jobId) => {
    localStorage.setItem('summarize-yt:lastJobId', jobId);
  }, JOB_ID);
  await page.clock.install();
  installJobMock(page, {
    statusResponses: [{ status: 503, body: { error: 'Temporary status outage.' } }],
  });
  await page.goto('/');
  await expect(page.locator('#output-error')).toBeVisible();
  await expect(page.locator('#resume-bar')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('summarize-yt:lastJobId'))).toBe(JOB_ID);
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
  await expect(page.locator('#status-message')).toHaveText(/ERROR/);
  // Failed jobs release the form so the user can retry immediately.
  await expect(page.locator('#video-url')).toBeEnabled();

  await page.click('#output-error [data-action="reset"]');
  await expect(page.locator('#note-empty')).toBeVisible();
  await expect(page.locator('#video-url')).toHaveValue('');
  await expect(page.locator('#video-url')).toBeEnabled();
  await expect(page.locator('#status-message')).toHaveText(/READY/);
});

test('retries a failed job from the error panel and resumes polling', async ({ page }) => {
  await gotoWithClock(page);
  let retryPosts = 0;
  const states = [
    { status: 'failed', error: 'The summarizer could not resolve the OpenRouter credential.' },
    { status: 'queued' },
    { status: 'running', stage: 'summarizing', progress: 100 },
    { status: 'done' },
  ];
  let pollIndex = 0;
  page.route('**/api/summarize', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ jobId: JOB_ID }) }),
  );
  page.route(`**/api/jobs/${JOB_ID}/retry`, (route) => {
    retryPosts += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: JOB_ID, status: 'queued', stage: null, progress: 0, error: null }),
    });
  });
  page.route(`**/api/jobs/${JOB_ID}`, (route) => {
    const state = states[Math.min(pollIndex, states.length - 1)] ?? {};
    pollIndex += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
  });
  page.route(`**/api/jobs/${JOB_ID}/result`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULT) }),
  );

  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');
  await expect(page.locator('#output-error')).toBeVisible();
  await expect(page.locator('#retry-button')).toBeVisible();
  await expect(page.locator('#video-url')).toBeEnabled();

  await page.click('#retry-button');
  expect(retryPosts, 'clicking RETRY must POST the retry endpoint exactly once').toBe(1);
  await expect(page.locator('#output-error')).toBeHidden();
  await expect(page.locator('#output-loading')).toBeVisible();
  await expect(page.locator('#status-message')).toHaveText(/QUEUED/);

  await page.clock.fastForward(2000);
  await expect(page.locator('#status-message')).toHaveText(/SUMMARIZING/);
  await page.clock.fastForward(2000);
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#status-message')).toHaveText(/DONE/);
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
  await expect(page.locator('#status-message')).toHaveText(/ERROR/);
});

test('rendered note downloads, and resets via Escape', async ({ page }) => {
  await gotoWithClock(page);
  installJobMock(page, { jobStates: [{ status: 'done' }] });
  await page.fill('#video-url', VALID_URL);
  await page.click('#submit-button');
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-title')).toHaveText(RESULT.title);
  await expect(page.locator('#status-message')).toHaveText(/DONE/);
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
  await expect(page.locator('#status-message')).toHaveText(/READY/);
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
  await expect(page.locator('#status-message')).toHaveText(/READY/);
});

const HISTORY_ID_ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HISTORY_ID_BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HISTORY_JOBS = [
  {
    jobId: HISTORY_ID_ALPHA,
    status: 'done',
    title: 'Alpha zoo',
    lang: 'en',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
  {
    jobId: HISTORY_ID_BETA,
    status: 'done',
    title: 'Beta cooking',
    lang: 'fr',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

test('history lists finished notes and opens one on click', async ({ page }) => {
  installJobMock(page, { jobStates: [], historyJobs: HISTORY_JOBS });
  page.route(`**/api/jobs/${HISTORY_ID_ALPHA}/result`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...RESULT, title: 'Alpha zoo' }),
    }),
  );
  await page.goto('/');
  const items = page.locator('#history-list li');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Alpha zoo');
  await expect(items.nth(1)).toContainText('Beta cooking');
  await page.click(`#history-list li[data-job-id="${HISTORY_ID_ALPHA}"] button`);
  await expect(page.locator('#note-content')).toBeVisible();
  await expect(page.locator('#note-title')).toHaveText('Alpha zoo');
  await expect(page.locator('#markdown-output h2').first()).toHaveText('Overview');
});

test('history renders titles as text, never as HTML', async ({ page }) => {
  installJobMock(page, {
    jobStates: [],
    historyJobs: [
      {
        jobId: HISTORY_ID_ALPHA,
        status: 'done',
        title: 'Alpha <b>zoo</b>',
        lang: 'en',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
  });
  await page.goto('/');
  const item = page.locator('#history-list li').first();
  await expect(item).toContainText('Alpha <b>zoo</b>');
  await expect(item.locator('b')).toHaveCount(0);
});

test('history search filters the list by title', async ({ page }) => {
  installJobMock(page, { jobStates: [], historyJobs: HISTORY_JOBS });
  await page.goto('/');
  await expect(page.locator('#history-list li')).toHaveCount(2);
  await page.fill('#history-search', 'bet');
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await expect(page.locator('#history-list li')).toContainText('Beta cooking');
});

test('history shows an empty state when there are no finished notes', async ({ page }) => {
  installJobMock(page, { jobStates: [], historyJobs: [] });
  await page.goto('/');
  await expect(page.locator('#history-empty')).toBeVisible();
  await expect(page.locator('#history-empty')).toContainText('NO NOTES YET');
  await expect(page.locator('#history-list li')).toHaveCount(0);
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
