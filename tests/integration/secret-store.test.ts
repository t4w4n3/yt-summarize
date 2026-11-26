/**
 * Integration tests for the SecretStore adapter (phase 2B).
 * Drives the port through real temporary files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { OpenRouterSecretError } from '../../src/application/ports/secret-store.ts';
import { createOpenRouterSecretStore } from '../../src/infrastructure/outbound/secrets/openrouter.ts';

let dir: string | undefined;

afterEach(() => {
  mock.restoreAll();
  if (dir !== undefined) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  dir = undefined;
});

function freshStore(rootPath: string, options: { secretPath?: string; apiKey?: string } = {}) {
  return createOpenRouterSecretStore({
    secretPath: options.secretPath ?? path.join(rootPath, 'openrouter_key'),
    apiKey: options.apiKey,
  });
}

function isolatedDirs() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-'));
  return dir;
}

describe('SecretStore (filesystem adapter)', () => {
  it('returns the last valid sk-or- key from the podman secret', async () => {
    const root = isolatedDirs();
    const secretPath = path.join(root, 'key');
    fs.writeFileSync(secretPath, 'noise\nsk-or-older\nsk-or-valid\n', 'utf8');
    const store = freshStore(root, { secretPath, apiKey: 'sk-or-env' });
    assert.equal(await store.resolveOpenRouterKey(), 'sk-or-valid');
  });

  it('throws a typed error when the podman secret holds garbage', async () => {
    const root = isolatedDirs();
    const secretPath = path.join(root, 'key');
    fs.writeFileSync(secretPath, 'not-an-openrouter-key\n', 'utf8');
    const store = freshStore(root, { secretPath, apiKey: 'sk-or-env' });
    await assert.rejects(store.resolveOpenRouterKey(), (error: unknown) => {
      if (!(error instanceof OpenRouterSecretError)) return false;
      assert.equal(error.code, 'invalid-secret');
      return true;
    });
  });

  it('treats an empty secret as missing and falls through to the explicit apiKey', async () => {
    const root = isolatedDirs();
    const secretPath = path.join(root, 'key');
    fs.writeFileSync(secretPath, '\n\n', 'utf8');
    const store = freshStore(root, {
      secretPath,
      apiKey: 'sk-or-fallback',
    });
    assert.equal(await store.resolveOpenRouterKey(), 'sk-or-fallback');
  });

  it('does not look for a legacy GPG file and falls through to the explicit apiKey', async () => {
    // Even if a file exists at the old bind-mount path, the store must not
    // attempt any GPG decryption: it only knows the podman secret + env var.
    mock.method(fs, 'existsSync', (filePath: fs.PathLike) => filePath.toString() === '/secrets/openrouter.gpg');
    mock.method(fs, 'readFileSync', () => 'not-a-real-gpg-file');
    try {
      const store = createOpenRouterSecretStore({
        secretPath: '/run/secrets/openrouter_key',
        apiKey: 'sk-or-env-fallback',
      });
      assert.equal(
        await store.resolveOpenRouterKey(),
        'sk-or-env-fallback',
        'with fs.existsSync(/secrets/openrouter.gpg)=true and readFileSync returning garbage, resolveOpenRouterKey must ignore the legacy path and return apiKey=sk-or-env-fallback, not throw a decryption error or return the garbage',
      );
    } finally {
      mock.restoreAll();
    }
  });

  it('treats the placeholder as missing and returns null when nothing else exists', async () => {
    const root = isolatedDirs();
    const secretPath = path.join(root, 'key');
    fs.writeFileSync(secretPath, 'sk-or-missing-placeholder\n', 'utf8');
    const store = freshStore(root, { secretPath, apiKey: '' });
    assert.equal(await store.resolveOpenRouterKey(), null);
  });
});
