import fs from 'node:fs';
import { loadConfig } from '../../shared/config.ts';

// Worker entrypoint (Node, no shell): compose runs this file directly with `node` (no shell in the boot path), so
// compose runs this file directly with `node`. It replaces the former
// image/entrypoint-worker.sh, which only created the data directories and
// warned about a missing credential before exec'ing worker.ts.
//
// The data/artifacts directories are also created by the stores below
// (job-store / artifact-store mkdirSync), but creating them here keeps the
// volume mounts visibly writable-checked before the polling loop starts
// and matches the old shell entrypoint behaviour.

const cfg = loadConfig(process.env);
fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(cfg.artifactsDir, { recursive: true });

// Secrets are delivered via podman secrets (tmpfs at /run/secrets/*,
// readable by `node`). The legacy GPG bind mount is gone: the host sync
// (scripts/sync-secrets.sh) decrypts and delivers the podman secret.
const SECRET_PATH = '/run/secrets/openrouter_key';
if (!fs.existsSync(SECRET_PATH)) {
  console.warn(
    'WARNING: No OpenRouter credential found (/run/secrets/openrouter_key); paid stages will fail at key resolution (local dev may still use OPENROUTER_API_KEY).',
  );
}

await import('./worker.ts');
