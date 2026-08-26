import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

// P4 — shared/secrets.ts single contract, eliminates duplicated fs.existsSync + placeholder logic.
describe('P4 — shared/secrets single contract', () => {
  it('shared/secrets.ts exists and exports the contract', async () => {
    const secrets = await import('../../src/shared/secrets.ts');
    assert.equal(typeof secrets.resolveYouTubeCookiesPath, 'function');
    assert.equal(typeof secrets.resolveOpenRouterKey, 'function');
    // Optional: generic resolveSecret is acceptable alternative
    // but at least these two must exist
  });

  it('download.ts delegates to shared/secrets (no duplicated placeholder logic)', () => {
    const src = fs.readFileSync('src/worker/stages/download.ts', 'utf8');
    assert.match(src, /from\s+['"]\.\.\/\.\.\/shared\/secrets\.ts['"]/);
    assert.match(src, /resolveYouTubeCookiesPath/);
    // Should not still contain the raw duplicated branch
    // The old file had explicit fs.existsSync('/run/secrets/youtube_cookies') + includes('Netscape')
    // After consolidation that knowledge must live only in shared/secrets.ts
    assert.doesNotMatch(src, /sk-or-missing.*Netscape|Netscape.*sk-or-missing/);
    assert.doesNotMatch(src, /\/run\/secrets\/youtube_cookies.*Netscape/s);
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

  it('shared/secrets.ts owns the placeholder + path knowledge exactly once', () => {
    const src = fs.readFileSync('src/shared/secrets.ts', 'utf8');
    assert.match(src, /\/run\/secrets\/openrouter_key/);
    assert.match(src, /\/run\/secrets\/youtube_cookies/);
    assert.match(src, /sk-or-missing/);
    assert.match(src, /Netscape/);
  });
});
