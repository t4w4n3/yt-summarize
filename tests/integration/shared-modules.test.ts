import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

// P3 — split shared/constants.ts into focused modules with single volatility.
// Test-first: these imports will fail until the split is implemented.
describe('P3 — shared/constants split into focused modules', () => {
  it('job.ts exports STAGES/STATUS with correct values (supporting, stable)', async () => {
    const job = await import('../../src/shared/job.ts');
    assert.deepEqual(job.STAGES, ['downloading', 'converting', 'transcribing', 'summarizing']);
    assert.equal(job.STATUS.QUEUED, 'queued');
    assert.equal(job.STATUS.RUNNING, 'running');
    assert.equal(job.STATUS.DONE, 'done');
    assert.equal(job.STATUS.FAILED, 'failed');
  });

  it('config.ts exports config and dbPath (generic, sticky)', async () => {
    const cfg = await import('../../src/shared/config.ts');
    assert.equal(typeof cfg.config.port, 'number');
    assert.equal(typeof cfg.config.dataDir, 'string');
    assert.equal(typeof cfg.dbPath(), 'string');
    assert.ok(cfg.dbPath().endsWith('jobs.db'));
  });

  it('timeouts.ts exports stageTimeoutMs with correct per-stage values', async () => {
    const t = await import('../../src/shared/timeouts.ts');
    assert.equal(t.stageTimeoutMs('downloading'), 10 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('converting'), 15 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('transcribing'), 25 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('summarizing'), 10 * 60 * 1000);
  });

  it('constants.ts remains a re-export facade for backward compat', () => {
    const src = fs.readFileSync('src/shared/constants.ts', 'utf8');
    // Facade must re-export from the focused modules (not duplicate definitions)
    assert.match(src, /from\s+['"]\.\/config\.ts['"]/);
    assert.match(src, /from\s+['"]\.\/job\.ts['"]/);
    assert.match(src, /from\s+['"]\.\/timeouts\.ts['"]/);
    // Must not still define STAGES/STAGE_TIMEOUTS inline (duplicated knowledge)
    // Allow at most re-export lines; original definitions should be gone.
    assert.doesNotMatch(src, /export const STAGES =/);
    assert.doesNotMatch(src, /const STAGE_TIMEOUTS/);
  });

  it('job.ts has no config/timeout knowledge (single volatility)', () => {
    const src = fs.readFileSync('src/shared/job.ts', 'utf8');
    assert.doesNotMatch(src, /STT_MODEL|LLM_MODEL|dbPath|stageTimeoutMs|STAGE_TIMEOUTS/);
    assert.doesNotMatch(src, /from\s+['"]\.\/config/);
  });

  it('config.ts has no STAGES/STATUS/timeout knowledge (single volatility)', () => {
    const src = fs.readFileSync('src/shared/config.ts', 'utf8');
    assert.doesNotMatch(src, /STAGES|STATUS|Stage\s*=/);
    assert.doesNotMatch(src, /STAGE_TIMEOUTS/);
  });

  it('internal consumers import from focused modules, not the big ball', () => {
    const pipeline = fs.readFileSync('src/worker/pipeline.ts', 'utf8');
    // pipeline needs STAGES + stageTimeoutMs + config — should import from focused files
    assert.match(pipeline, /from\s+['"]\.\.\/shared\/job\.ts['"]/);
    assert.match(pipeline, /from\s+['"]\.\.\/shared\/timeouts\.ts['"]/);
    assert.match(pipeline, /from\s+['"]\.\.\/shared\/config\.ts['"]/);
    assert.doesNotMatch(pipeline, /from\s+['"]\.\.\/shared\/constants\.ts['"]/);

    const db = fs.readFileSync('src/shared/db.ts', 'utf8');
    assert.match(db, /from\s+['"]\.\/config\.ts['"]/);
    assert.match(db, /from\s+['"]\.\/job\.ts['"]/);
    // db should not pull timeouts
    assert.doesNotMatch(db, /from\s+['"]\.\.\/shared\/constants/);
    assert.doesNotMatch(db, /from\s+['"]\.\/constants/);
  });
});
