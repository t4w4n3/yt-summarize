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
});
