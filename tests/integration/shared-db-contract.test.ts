import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

// P5 — document the app↔worker shared-DB tradeoff, don't "fix" it yet.
describe('P5 — pragmatic shared-DB tradeoff is documented', () => {
  it('src/infrastructure/outbound/sqlite/job-store.ts documents the shared-model tradeoff', () => {
    const src = fs.readFileSync('src/infrastructure/outbound/sqlite/job-store.ts', 'utf8');
    assert.match(src, /Pragmatic shared-model/);
    assert.match(src, /app\+worker|app \+ worker|app\/worker/);
    assert.match(src, /jobs-data/);
    assert.match(src, /not VOLATILITY|low volatility|supporting/i);
    assert.match(src, /Revisit if queue/i);
  });

  it('compose.yaml documents the shared-DB tradeoff', () => {
    const src = fs.readFileSync('compose.yaml', 'utf8');
    assert.match(src, /Pragmatic shared-model/);
    assert.match(src, /jobs-data/);
    assert.match(src, /Revisit if queue/i);
  });
});
