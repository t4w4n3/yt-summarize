/**
 * Unit tests for the pure error-mapping helpers in src/worker/pipeline.ts.
 *
 * `stageOf` and `friendlyError` convert arbitrary thrown errors into
 * stage-attributed, user-facing messages. This is the mapping the whole
 * worker UX relies on (a regression here surfaces raw internals to users).
 *
 * Category: unit — pure functions, no I/O.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { friendlyError, stageOf } from '../../src/worker/pipeline.ts';
import { StageError } from '../../src/worker/stages/process.ts';

describe('pipeline — stage attribution & friendly errors', () => {
  it('stageOf returns the stage for a StageError', () => {
    assert.equal(stageOf(new StageError('boom', 'transcribing')), 'transcribing');
  });

  it('stageOf returns stage for a generic error carrying a stage property', () => {
    const err = new Error('boom') as Error & { stage?: string | null };
    err.stage = 'converting';
    assert.equal(stageOf(err), 'converting');
  });

  it('stageOf returns null for an error without stage info', () => {
    assert.equal(stageOf(new Error('boom')), null);
    assert.equal(stageOf('plain string'), null);
    assert.equal(stageOf(undefined), null);
  });

  it('friendlyError maps downloading failures to a user-facing message', () => {
    const msg = friendlyError(new StageError('some internal detail', 'downloading', 'YouTube said nope'));
    assert.match(msg, /YouTube could not provide this video/);
    assert.ok(!msg.includes('StageError'), 'should not leak internal error class');
  });

  it('friendlyError passes through transcribing model-missing message verbatim', () => {
    const msg = friendlyError(new StageError('the model is missing', 'transcribing'));
    assert.equal(msg, 'the model is missing');
  });

  it('friendlyError maps summarizing credential/auth failures to a user-facing message', () => {
    const msg = friendlyError(new StageError('401 Unauthorized', 'summarizing', 'auth failed'));
    assert.match(msg, /could not resolve the OpenRouter credential/i);
  });

  it('friendlyError appends details for other StageErrors', () => {
    const err = new StageError('Summarization failed (HTTP 429).', 'summarizing', 'rate limited');
    const msg = friendlyError(err);
    assert.match(msg, /Summarization failed/);
    assert.match(msg, /rate limited/);
  });

  it('friendlyError returns the message for a plain Error', () => {
    assert.equal(friendlyError(new Error('oops')), 'oops');
  });

  it('friendlyError returns a sensible default for empty/unknown errors', () => {
    assert.equal(friendlyError(new Error('')), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError(null), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError(0), 'The worker stopped unexpectedly.');
  });

  it('friendlyError handles downloading without details (no trailing space)', () => {
    const msg = friendlyError(new StageError('oops', 'downloading'));
    assert.match(msg, /YouTube could not provide this video/);
    assert.equal(msg.endsWith('correct.'), true);
  });

  it('friendlyError truncates long details to 600 chars', () => {
    const long = 'x'.repeat(800);
    const msg = friendlyError(new StageError('fail', 'downloading', long));
    // detail is ` ` + last 600 chars of long
    assert.ok(msg.includes('x'.repeat(600)));
    assert.equal(msg.includes('x'.repeat(601)), false);
    assert.match(msg, /YouTube could not provide this video/);
  });

  it('friendlyError does not map transcribing without model missing', () => {
    const err = new StageError('Transcription failed (HTTP 500).', 'transcribing', 'nope');
    const msg = friendlyError(err);
    assert.match(msg, /Transcription failed/);
    assert.match(msg, /nope/);
    assert.equal(msg.includes('model is missing'), false);
  });

  it('friendlyError maps transcribing model-missing even with details (verbatim)', () => {
    const msg = friendlyError(new StageError('the model is missing from catalog', 'transcribing', 'extra detail'));
    assert.equal(msg, 'the model is missing from catalog');
  });

  it('friendlyError maps summarizing credential failures for various patterns', () => {
    for (const pattern of ['credential', 'auth', 'api key', '401', '403']) {
      const msg = friendlyError(new StageError(`fail ${pattern}`, 'summarizing'));
      assert.match(msg, /could not resolve the OpenRouter credential/i, `pattern ${pattern} should map`);
    }
    const plain = friendlyError(new StageError('Summarization failed (HTTP 429).', 'summarizing', 'rate limited'));
    assert.match(plain, /Summarization failed/);
    assert.match(plain, /rate limited/);
  });

  it('friendlyError handles StageError with unknown stage as message+detail', () => {
    const err = new StageError('convert broke', 'converting', 'ffmpeg barfed');
    const msg = friendlyError(err);
    assert.equal(msg, 'convert broke ffmpeg barfed');
  });

  it('friendlyError handles string and non-string errors', () => {
    assert.equal(friendlyError('plain string'), 'plain string');
    assert.equal(friendlyError(''), 'The worker stopped unexpectedly.');
    assert.equal(friendlyError(42), 'The worker stopped unexpectedly.');
  });

  it('stageOf handles StageError with empty stage and generic errors with empty stage', () => {
    assert.equal(stageOf(new StageError('boom', '')), '');
    const err = new Error('boom') as Error & { stage?: string | null };
    err.stage = '';
    assert.equal(stageOf(err), '');
    const nullStage = new Error('boom') as Error & { stage?: string | null };
    nullStage.stage = null;
    assert.equal(stageOf(nullStage), null);
  });
});
