import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Single contract for secret layout — podman secret → legacy GPG → env var
// for the OpenRouter key. Downloads go through the Mullvad sidecar.

const OPENROUTER_SECRET_PATH = '/run/secrets/openrouter_key';
const OPENROUTER_LEGACY_GPG = '/secrets/openrouter.gpg';

export type OpenRouterSecretErrorCode = 'invalid-secret' | 'decryption-failed';

/** Stable failure type for OpenRouter credential resolution across module boundaries. */
export class OpenRouterSecretError extends Error {
  readonly code: OpenRouterSecretErrorCode;

  constructor(message: string, code: OpenRouterSecretErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenRouterSecretError';
    this.code = code;
  }
}

/**
 * Resolve the OpenRouter API key.
 * Tries podman secret → legacy GPG → env var.
 * Returns the key string when found, null when missing (placeholder counts as missing).
 * Throws an OpenRouterSecretError when a configured secret is invalid or GPG
 * decryption fails — callers (worker layer) translate this at the stage boundary
 * so `shared` never depends on `worker`.
 */
export async function resolveOpenRouterKey(): Promise<string | null> {
  // 1) podman secret (rootless-friendly, tmpfs 0440)
  if (fs.existsSync(OPENROUTER_SECRET_PATH)) {
    const raw = fs.readFileSync(OPENROUTER_SECRET_PATH, 'utf8');
    const key =
      raw
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) || '';
    if (!key) {
      // empty file → treat as missing, fall through
    } else if (key.includes('sk-or-missing')) {
      // dummy placeholder from sync-secrets.sh → treat as missing
    } else if (key.startsWith('sk-or-')) {
      return key;
    } else {
      throw new OpenRouterSecretError(
        `secret at ${OPENROUTER_SECRET_PATH} did not contain a valid sk-or- key`,
        'invalid-secret',
      );
    }
  }

  // 2) legacy GPG path (bind mount, requires gnupg + keyring)
  if (fs.existsSync(OPENROUTER_LEGACY_GPG)) {
    return decryptViaGpg(OPENROUTER_LEGACY_GPG);
  }

  // 3) env var escape hatch for local dev without podman
  if (process.env.OPENROUTER_API_KEY?.startsWith('sk-or-')) {
    return process.env.OPENROUTER_API_KEY.trim();
  }

  return null;
}

function decryptViaGpg(gpgPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('gpg', ['--quiet', '--batch', '--no-tty', '--decrypt', gpgPath], {
      env: { ...process.env, GNUPGHOME: process.env.GNUPGHOME || '/run/gnupg' },
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      clearTimeout(timeout);
      reject(
        new OpenRouterSecretError(`Could not decrypt the OpenRouter key: ${error.message}`, 'decryption-failed', {
          cause: error,
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const key =
        stdout
          .trim()
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) || '';
      if (code !== 0 || !key.startsWith('sk-or-')) {
        const detail = stderr.trim().slice(-400);
        const cause = new Error(detail || `gpg exited with code ${code ?? 'unknown'}`);
        reject(
          new OpenRouterSecretError(
            'Could not resolve the OpenRouter credential from the legacy encrypted secret.',
            'decryption-failed',
            { cause },
          ),
        );
      } else {
        resolve(key);
      }
    });
  });
}
