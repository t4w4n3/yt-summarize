const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StageError } = require('./process');

// Resolve the OpenRouter API key. Preferred path is the podman secret
// at /run/secrets/openrouter_key (tmpfs, 0440, readable by `node`).
// Falls back to the legacy GPG-encrypted bind mount at /secrets/openrouter.gpg
// for backwards compat during the migration window. The plaintext is kept in
// worker memory for the lifetime of a single request and never written to disk.
async function resolveOpenRouterKey() {
  // 1) podman secret (rootless-friendly)
  const secretPath = '/run/secrets/openrouter_key';
  if (fs.existsSync(secretPath)) {
    try {
      const raw = fs.readFileSync(secretPath, 'utf8');
      const key =
        raw
          .trim()
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) || '';
      if (key.startsWith('sk-or-')) return key;
      // dummy placeholder from sync script (sk-or-missing) → fall through to error
      if (key) {
        throw new StageError(
          'Could not resolve the OpenRouter credential. Check the podman secret and worker logs.',
          'pipeline',
          `secret at ${secretPath} did not contain a valid sk-or- key`,
        );
      }
    } catch (error) {
      if (error instanceof StageError) throw error;
      throw new StageError('Could not read the OpenRouter secret.', 'pipeline', error.message);
    }
  }

  // 2) legacy GPG path (bind mount, requires gnupg + keyring)
  const gpgPath = '/secrets/openrouter.gpg';
  if (fs.existsSync(gpgPath)) {
    return decryptViaGpg(gpgPath);
  }

  // 3) env var escape hatch for local dev without podman
  if (process.env.OPENROUTER_API_KEY?.startsWith('sk-or-')) {
    return process.env.OPENROUTER_API_KEY.trim();
  }

  throw new StageError(
    'Could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.',
    'pipeline',
    `no secret at ${secretPath} and no legacy file at ${gpgPath}`,
  );
}

function decryptViaGpg(gpgPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('gpg', ['--quiet', '--batch', '--no-tty', '--decrypt', gpgPath], {
      env: { ...process.env, GNUPGHOME: process.env.GNUPGHOME || '/run/gnupg' },
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new StageError('Could not decrypt the OpenRouter key.', 'pipeline', error.message));
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
        reject(
          new StageError(
            'Could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.',
            'pipeline',
            stderr.trim().slice(-400),
          ),
        );
      } else {
        resolve(key);
      }
    });
  });
}

module.exports = { resolveOpenRouterKey };
