import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it, mock } from 'node:test';
import { OpenRouterSecretError, resolveOpenRouterKey } from '../../src/shared/secrets.ts';

// OpenRouter secret contract.
describe('shared/secrets OpenRouter contract', () => {
  it('shared/secrets.ts exists and exports the OpenRouter contract', async () => {
    const secrets = await import('../../src/shared/secrets.ts');
    assert.equal(typeof secrets.resolveOpenRouterKey, 'function');
  });

  it('uses a stable typed error for invalid OpenRouter secret contents', () => {
    const cause = new Error('invalid fixture');
    const error = new OpenRouterSecretError('invalid secret', 'invalid-secret', { cause });
    assert.equal(error.code, 'invalid-secret');
    assert.equal(error.cause, cause);
    assert.equal(error.name, 'OpenRouterSecretError');
  });

  it('preserves the typed error when the podman secret is invalid', async () => {
    mock.method(fs, 'existsSync', (filePath: fs.PathLike) => filePath.toString() === '/run/secrets/openrouter_key');
    mock.method(fs, 'readFileSync', () => 'not-an-openrouter-key');
    try {
      await assert.rejects(resolveOpenRouterKey(), (error: unknown) => {
        if (!(error instanceof OpenRouterSecretError)) return false;
        assert.equal(error.code, 'invalid-secret');
        return true;
      });
    } finally {
      mock.restoreAll();
    }
  });

  it('openrouter.ts delegates to shared/secrets (no duplicated GPG/podman branch)', () => {
    const src = fs.readFileSync('src/worker/stages/openrouter.ts', 'utf8');
    // Must import from shared/secrets, not re-implement fs.existsSync('/run/secrets/openrouter_key') inline
    assert.match(src, /from\s+['"]\.\.\/\.\.\/shared\/secrets\.ts['"]/);
    // The raw podman secret path should not be hard-coded twice (in both openrouter.ts and download.ts)
    // After consolidation it lives only in shared/secrets.ts; openrouter.ts should not have duplicate validation
    const count = (src.match(/\/run\/secrets\/openrouter_key/g) || []).length;
    assert.ok(count <= 1, `openrouter.ts should not duplicate secret path logic (found ${count} occurrences)`);
  });

  it('openrouter.ts classifies shared secret failures without message substring coupling', () => {
    const src = fs.readFileSync('src/worker/stages/openrouter.ts', 'utf8');
    assert.match(src, /OpenRouterSecretError/);
    assert.doesNotMatch(src, /message\.includes\(/);
  });

  it('shared/secrets.ts owns the OpenRouter placeholder + path knowledge exactly once', () => {
    const src = fs.readFileSync('src/shared/secrets.ts', 'utf8');
    assert.match(src, /\/run\/secrets\/openrouter_key/);
    assert.match(src, /sk-or-missing/);
  });
});
