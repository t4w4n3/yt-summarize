/**
 * Architecture test — settings enter the process in exactly one place.
 *
 * Category: arch — enforced by scanning source text (same house style as the
 * "single volatility" checks in tests/integration/shared-modules).
 *
 * Why: podman-compose 1.3.0 passes the literal string `${VAR:-default}` to the
 * container when VAR is absent from `.env` (`podman-compose config` proves it).
 * shared/config.ts knows how to read that literal — a raw `process.env.X` read
 * does not, and silently gets `${MULLVAD_ENABLED:-true}` where it expected
 * 'true', which turns the VPN off instead of failing. Routing every setting
 * through config makes that impossible in one place; this test keeps it true.
 *
 * Out of scope, deliberately:
 *  - src/shared/config.ts        — the one reader (and the only place that
 *                                  knows about the compose literal).
 *  - src/shared/secrets.ts       — OPENROUTER_API_KEY fallback by design.
 *  - src/vpn/**                  — separate sidecar process, own env contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const SRC = 'src';
/** Directories that must reach their settings through shared/config. */
const GUARDED_DIRS = ['worker', 'app', 'domain'] as const;

/** A read: `process.env.X` or `process.env['X']`. A spread (`...process.env`) is not a read. */
const ENV_READ = /process\.env(?:\.|\[)/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('architecture — settings come from shared/config', () => {
  it('worker, app and domain never read process.env directly', () => {
    const offenders: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of tsFilesUnder(path.join(SRC, dir))) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const [index, line] of lines.entries()) {
          if (ENV_READ.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `read settings through src/shared/config.ts instead — a raw process.env read cannot recognise the ` +
        `un-interpolated \${VAR:-default} literal that podman-compose passes:\n${offenders.join('\n')}`,
    );
  });

  it('the e2e stack never reuses a running server', () => {
    // global-setup wipes e2e/.tmp/data before the servers start. A reused server
    // keeps its handle on the deleted SQLite file, so POST /api/summarize then
    // answers 200 (deduped) where a fresh run answers 201, so a green suite could
    // have tested a database nobody created. Refusing to reuse turns a busy port
    // into a loud failure instead.
    const src = fs.readFileSync('e2e/playwright.config.ts', 'utf8');
    const values = [...src.matchAll(/reuseExistingServer:\s*([^,\n}]+)/g)].map((match) => (match[1] ?? '').trim());
    assert.deepEqual(
      values,
      ['false', 'false'],
      'every e2e webServer must set reuseExistingServer: false (its data dir is wiped before it starts)',
    );
  });

  it('shared/config.ts is the single place that parses the compose literal', () => {
    const readers = tsFilesUnder(path.join(SRC, 'shared'))
      .filter((file) => !file.endsWith(path.join('config.ts')))
      .filter((file) => !file.endsWith(path.join('secrets.ts')))
      .filter((file) => ENV_READ.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(
      readers,
      [],
      'only config.ts (settings) and secrets.ts (documented key fallback) may read process.env',
    );
  });
});
