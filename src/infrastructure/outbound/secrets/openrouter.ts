import fs from 'node:fs';
import { OpenRouterSecretError, type SecretStore } from '../../../application/ports/secret-store.ts';

export type { OpenRouterSecretErrorCode } from '../../../application/ports/secret-store.ts';
export { OpenRouterSecretError };

// Single contract for secret layout — podman secret → env var
// for the OpenRouter key. Downloads go through the Mullvad sidecar.
// The legacy GPG bind-mount fallback (/secrets/openrouter.gpg + gnupg in the
// worker image) was removed: the host-side sync (scripts/sync-secrets.sh)
// decrypts with the host keyring and delivers plaintext via the podman
// secret, so the worker image needs no gnupg and no keyring.

const OPENROUTER_SECRET_PATH = '/run/secrets/openrouter_key';

export interface OpenRouterSecretStoreOptions {
  secretPath?: string;
  apiKey?: string;
}

/**
 * Resolve the OpenRouter API key.
 * Tries podman secret → env var.
 * Returns the key string when found, null when missing (placeholder counts as missing).
 * Throws an OpenRouterSecretError when a configured secret is invalid —
 * callers (worker layer) translate this at the stage boundary
 * so `shared` never depends on `worker`.
 */
export function createOpenRouterSecretStore(options: OpenRouterSecretStoreOptions = {}): SecretStore {
  const secretPath = options.secretPath ?? OPENROUTER_SECRET_PATH;
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

      // 2) env var escape hatch for local dev without podman
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
