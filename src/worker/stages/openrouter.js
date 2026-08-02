const { spawn } = require('node:child_process');
const { StageError } = require('./process');

// The OpenRouter key is GPG-encrypted at rest and mounted read-only at
// /secrets/openrouter.gpg. It is decrypted into worker memory for the lifetime
// of a single request; the plaintext is never written to disk. The keyring is
// copied to a writable $GNUPGHOME by the worker entrypoint.
function resolveOpenRouterKey() {
  return new Promise((resolve, reject) => {
    const child = spawn('gpg', ['--quiet', '--batch', '--no-tty', '--decrypt', '/secrets/openrouter.gpg'], {
      env: { ...process.env, GNUPGHOME: process.env.GNUPGHOME || '/run/gnupg' },
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(new StageError('Could not decrypt the OpenRouter key.', 'pipeline', error.message)); });
    child.on('close', code => {
      clearTimeout(timeout);
      const key = stdout.trim().split('\n').map(line => line.trim()).filter(Boolean).at(-1) || '';
      if (code !== 0 || !key.startsWith('sk-or-')) {
        reject(new StageError('Could not resolve the OpenRouter credential. Check the GPG mounts and worker logs.', 'pipeline', stderr.trim().slice(-400)));
      } else {
        resolve(key);
      }
    });
  });
}

module.exports = { resolveOpenRouterKey };
