/**
 * Unit tests for the application error mapping (phase 1D, moved from
 * worker/pipeline.ts). Expected strings are independent literals.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StageError } from '../../src/application/errors.ts';
import { friendlyError, stageOf } from '../../src/application/friendly-error.ts';

describe('application — stageOf', () => {
  it('StageError carries its stage', () => {
    assert.equal(stageOf(new StageError('boom', 'transcribing')), 'transcribing');
  });

  it('generic errors with a stage property keep it', () => {
    const err = new Error('boom') as Error & { stage?: string | null };
    err.stage = 'converting';
    assert.equal(stageOf(err), 'converting');
  });

  it('no stage info → null', () => {
    assert.equal(stageOf(new Error('boom')), null);
    assert.equal(stageOf('plain string'), null);
    assert.equal(stageOf(undefined), null);
  });
});

describe('application — friendlyError', () => {
  it('downloading failures map to the user-facing YouTube message', () => {
    const msg = friendlyError(new StageError('some internal detail', 'downloading', 'YouTube said nope'));
    assert.match(msg, /YouTube could not provide this video/);
    assert.ok(!msg.includes('StageError'));
  });

  it('downloading size-cap failures map to the size-limit message', () => {
    const fromCheck = friendlyError(
      new StageError('Video audio is too large: it exceeds the maximum download size of 500 MB.', 'downloading'),
    );
    assert.match(fromCheck, /too (long|large)/i);
    const fromYtDlp = friendlyError(
      new StageError(
        'downloading failed with exit code 1.',
        'downloading',
        'ERROR: File is larger than max-filesize (500M)',
      ),
    );
    assert.match(fromYtDlp, /too (long|large)/i);
  });

  it('downloading network failures map to the infra message', () => {
    const msg = friendlyError(new StageError('conn', 'downloading', 'connect ECONNREFUSED'));
    assert.match(msg, /download service is temporarily unavailable/);
  });

  it('transcribing model-missing passes through verbatim', () => {
    assert.equal(friendlyError(new StageError('the model is missing', 'transcribing')), 'the model is missing');
  });

  it('summarizing credential/auth failures map to the credential message', () => {
    const msg = friendlyError(new StageError('401 Unauthorized', 'summarizing', 'auth failed'));
    assert.match(msg, /could not resolve the OpenRouter credential/i);
  });

  it('summarizing credential present only in details still maps (classification, not leakage)', () => {
    const msg = friendlyError(
      new StageError(
        'The summarization API could not be reached.',
        'summarizing',
        'HTTP 403 from provider at /run/secrets/openrouter_key',
      ),
    );
    assert.match(
      msg,
      /could not resolve the OpenRouter credential/i,
      `details-only 403 must map to credential message, got: ${msg}`,
    );
    assert.equal(
      msg.includes('/run/secrets/openrouter_key'),
      false,
      `secret path from details must not leak, got: ${msg}`,
    );
  });

  it('size-cap rejections (F-1) surface exactly the clean user message, no detail appended', () => {
    for (const stage of ['converting', 'transcribing', 'summarizing']) {
      const msg = friendlyError(
        new StageError('This video is too long to process: its audio exceeds the maximum size limit.', stage),
      );
      assert.equal(
        msg,
        'This video is too long to process: its audio exceeds the maximum size limit.',
        `stage=${stage} must surface the clean message verbatim, got: ${msg}`,
      );
    }
  });

  it('StageError details never reach the user message (todo: frottage erreurs)', () => {
    const cases: Array<{ stage: string; message: string; details: string; leaked: string }> = [
      {
        stage: 'downloading',
        message: 'downloading failed with exit code 1.',
        details: 'ERROR: proxy socks5h://vpn:1080 failed for /artifacts/job-1/audio.m4a',
        leaked: 'socks5h://vpn:1080',
      },
      {
        stage: 'downloading',
        message: 'conn',
        details: 'connect ECONNREFUSED socks5h://vpn:1080 /artifacts/job-1',
        leaked: '/artifacts/job-1',
      },
      {
        stage: 'downloading',
        message: 'downloading failed with exit code 1.',
        details: 'ERROR: Video unavailable, see /artifacts/job-9/stderr.log',
        leaked: '/artifacts/job-9/stderr.log',
      },
      {
        stage: 'transcribing',
        message: 'Transcription failed (HTTP 500).',
        details: '{"error":{"message":"provider body sk-or-v1-secret"}} at /artifacts/job-1/audio.wav',
        leaked: 'sk-or-v1-secret',
      },
      {
        stage: 'summarizing',
        message: 'Summarization failed (HTTP 429).',
        details: '{"error":"rate limited"} provider body',
        leaked: 'provider body',
      },
      {
        stage: 'converting',
        message: 'convert broke',
        details: 'ffmpeg barfed on /artifacts/job-1/audio.wav',
        leaked: '/artifacts/job-1/audio.wav',
      },
    ];
    for (const { stage, message, details, leaked } of cases) {
      const msg = friendlyError(new StageError(message, stage, details));
      assert.equal(
        msg.includes(leaked),
        false,
        `stage=${stage} details=${JSON.stringify(details)} must not leak ${JSON.stringify(leaked)} into user message, got: ${JSON.stringify(msg)}`,
      );
      assert.equal(
        msg.includes(details),
        false,
        `stage=${stage} full details must not appear in user message, got: ${JSON.stringify(msg)}`,
      );
    }
  });

  it('other StageErrors keep message only, without detail', () => {
    const err = new StageError('Summarization failed (HTTP 429).', 'summarizing', 'rate limited');
    const msg = friendlyError(err);
    assert.equal(msg, 'Summarization failed (HTTP 429).', `message-only expected, got: ${msg}`);
  });

  it('plain errors pass through; empty/unknown get the default', () => {
    assert.equal(friendlyError(new Error('oops')), 'oops');
    assert.equal(friendlyError(new Error('')), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError(null), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError(0), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError('plain string'), 'plain string');
    assert.equal(friendlyError(''), 'The worker stopped unexpectedly.');
  });

  it('long details are dropped entirely, not truncated into the message', () => {
    const msg = friendlyError(new StageError('fail', 'downloading', 'x'.repeat(800)));
    assert.equal(
      msg.includes('x'),
      false,
      `800 x's of details must not appear in user message, got: ${JSON.stringify(msg)}`,
    );
    assert.equal(
      msg,
      'YouTube could not provide this video. Check that it is public and the URL is correct.',
      `downloading fallback message expected verbatim, got: ${JSON.stringify(msg)}`,
    );
  });
});
