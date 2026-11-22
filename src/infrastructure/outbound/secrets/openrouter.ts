import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { OpenRouterSecretError, type SecretStore } from '../../../application/ports/secret-store.ts';

export type { OpenRouterSecretErrorCode } from '../../../application/ports/secret-store.ts';
export { OpenRouterSecretError };

// Single contract for secret layout — podman secret → legacy GPG → env var
// for the OpenRouter key. Downloads go through the Mullvad sidecar.

const OPENROUTER_SECRET_PATH = '/run/secrets/openrouter_key';
const OPENROUTER_LEGACY_GPG = '/secrets/openrouter.gpg';

export interface OpenRouterSecretStoreOptions {
  secretPath?: string;
  legacyGpgPath?: string;
  apiKey?: string;
  gnupgHome?: string;
  gpgTimeoutMs?: number;
}

/**
 * Resolve the OpenRouter API key.
 * Tries podman secret → legacy GPG → env var.
 * Returns the key string when found, null when missing (placeholder counts as missing).
 * Throws an OpenRouterSecretError when a configured secret is invalid or GPG
 * decryption fails — callers (worker layer) translate this at the stage boundary
 * so `shared` never depends on `worker`.
 */
export function createOpenRouterSecretStore(options: OpenRouterSecretStoreOptions = {}): SecretStore {
  const secretPath = options.secretPath ?? OPENROUTER_SECRET_PATH;
  const legacyGpgPath = options.legacyGpgPath ?? OPENROUTER_LEGACY_GPG;
  const gpgTimeoutMs = options.gpgTimeoutMs ?? 30_000;
  const gnupgHome = options.gnupgHome ?? process.env.GNUPGHOME ?? '/run/gnupg';
  return {
    async resolveOpenRouterKey(): Promise<string | null> {
      // 1) podman secret (rootless-friendly, tmpfs 0440)
      if (fs.existsSync(secretPath)) {
        const raw = fs.readFileSync(secretPath, 'utf8');
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
            `secret at ${secretPath} did not contain a valid sk-or- key`,
            'invalid-secret',
          );
        }
      }

      // 2) legacy GPG path (bind mount, requires gnupg + keyring)
      if (fs.existsSync(legacyGpgPath)) {
        return decryptViaGpg(legacyGpgPath, { timeoutMs: gpgTimeoutMs, gnupgHome });
      }

      // 3) env var escape hatch for local dev without podman
      const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.OPENROUTER_API_KEY;
      if (apiKey?.startsWith('sk-or-')) {
        return apiKey.trim();
      }

      return null;
    },
  };
}

export async function resolveOpenRouterKey(): Promise<string | null> {
  return createOpenRouterSecretStore().resolveOpenRouterKey();
}

function decryptViaGpg(gpgPath: string, options: { timeoutMs: number; gnupgHome: string }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('gpg', ['--quiet', '--batch', '--no-tty', '--decrypt', gpgPath], {
      env: { ...process.env, GNUPGHOME: options.gnupgHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
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
