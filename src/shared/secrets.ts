import { spawn } from 'node:child_process';
import fs from 'node:fs';

// Single contract for secret layout — consolidation of the duplicated
// `fs.existsSync('/run/secrets/…')` → placeholder → fallback knowledge that
// previously lived in both download.ts (cookies) and openrouter.ts (key).
// See docs/coupling-review.md P4.

const OPENROUTER_SECRET_PATH = '/run/secrets/openrouter_key';
const OPENROUTER_LEGACY_GPG = '/secrets/openrouter.gpg';
const COOKIES_SECRET_PATH = '/run/secrets/youtube_cookies';
const COOKIES_LEGACY_PATH = '/secrets/youtube-cookies.txt';
const COOKIES_PLACEHOLDER = '# empty - no cookies';
const NETSCAPE_COOKIE_HEADER = '# Netscape HTTP Cookie File';

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

function isNetscapeCookiesFile(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(NETSCAPE_COOKIE_HEADER) || lines.includes(COOKIES_PLACEHOLDER)) return false;
  return lines.some((line) => {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return false;
    return line.split('\t').length === 7;
  });
}

/**
 * Resolve the YouTube cookies file path for yt-dlp.
 * Returns the podman secret path if it contains a real Netscape cookies file,
 * otherwise the legacy bind-mount path, otherwise null.
 */
export function resolveYouTubeCookiesPath(): string | null {
  if (fs.existsSync(COOKIES_SECRET_PATH)) {
    const stat = fs.statSync(COOKIES_SECRET_PATH);
    if (stat.size > 0 && isNetscapeCookiesFile(fs.readFileSync(COOKIES_SECRET_PATH, 'utf8'))) {
      return COOKIES_SECRET_PATH;
    }
  }
  if (fs.existsSync(COOKIES_LEGACY_PATH)) {
    return COOKIES_LEGACY_PATH;
  }
  return null;
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
