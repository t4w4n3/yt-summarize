/**
 * Behavioral tests for src/worker/stages/openrouter.ts — the stage-boundary
 * credential resolver that translates shared secret failures into StageErrors.
 *
 * We drive the real shared resolveOpenRouterKey by mocking fs/existsSync so the
 * podman/legacy/env resolution paths are exercised without real secrets, then
 * assert openrouter.ts translates the outcome into a stage-attributed error.
 *
 * Category: integration — adapter boundary (mocked fs / env).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';
import { OpenRouterSecretError } from '../../src/shared/secrets.ts';
import { resolveOpenRouterKey } from '../../src/worker/stages/openrouter.ts';
import { StageError } from '../../src/worker/stages/process.ts';

const OPENROUTER_SECRET_PATH = '/run/secrets/openrouter_key';

/** Make fs.existsSync/readFileSync answer only from this map (with statSync). */
function stubFs(files: Map<string, string>): void {
  mock.method(fs, 'existsSync', (filePath: fs.PathLike) => files.has(filePath.toString()));
  mock.method(fs, 'readFileSync', (filePath: fs.PathLike) => files.get(filePath.toString()) ?? '');
  mock.method(
    fs,
    'statSync',
    (filePath: fs.PathLike) => ({ size: files.get(filePath.toString())?.length ?? 0 }) as fs.Stats,
  );
}

describe('openrouter stage — translate shared secret resolution', () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('returns the key when the podman secret holds a valid sk-or- key', async () => {
    stubFs(new Map([[OPENROUTER_SECRET_PATH, 'sk-or-valid\n']]));
    assert.equal(await resolveOpenRouterKey(), 'sk-or-valid');
  });

  it('throws a pipeline StageError when no secret is present anywhere', async () => {
    stubFs(new Map());
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(resolveOpenRouterKey(), (error: unknown) => {
      assert.ok(error instanceof StageError);
      assert.equal(error.stage, 'pipeline');
      assert.match(error.message, /Could not resolve the OpenRouter credential/i);
      return true;
    });
  });

  it('translates an invalid-secret OpenRouterSecretError into a pipeline StageError preserving the cause', async () => {
    stubFs(new Map([[OPENROUTER_SECRET_PATH, 'not-an-openrouter-key']]));
    await assert.rejects(resolveOpenRouterKey(), (error: unknown) => {
      assert.ok(error instanceof StageError);
      assert.equal(error.stage, 'pipeline');
      assert.ok(error.cause instanceof OpenRouterSecretError);
      return true;
    });
  });

  it('falls back to the OPENROUTER_API_KEY env var when no secret file exists', async () => {
    stubFs(new Map());
    process.env.OPENROUTER_API_KEY = 'sk-or-env-key';
    assert.equal(await resolveOpenRouterKey(), 'sk-or-env-key');
  });

  it('treats an empty podman secret as missing and falls through to env', async () => {
    stubFs(new Map([[OPENROUTER_SECRET_PATH, '\n\n']]));
    process.env.OPENROUTER_API_KEY = 'sk-or-env-fallback';
    assert.equal(await resolveOpenRouterKey(), 'sk-or-env-fallback');
  });

  it('treats the sk-or-missing placeholder as missing', async () => {
    stubFs(new Map([[OPENROUTER_SECRET_PATH, 'sk-or-missing-placeholder\n']]));
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(resolveOpenRouterKey(), (error: unknown) => error instanceof StageError);
  });
});
