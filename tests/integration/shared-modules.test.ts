import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

// P3 — constants are focused modules with single volatility.
describe('P3 — focused constants modules', () => {
  it('domain job entity exports STAGES/STATUS with correct values (supporting, stable)', async () => {
    const job = await import('../../src/domain/job/entity.ts');
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

  it('application/stage-timeouts exports stageTimeoutMs with correct per-stage values', async () => {
    const t = await import('../../src/application/stage-timeouts.ts');
    assert.equal(t.stageTimeoutMs('downloading'), 10 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('converting'), 15 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('transcribing'), 25 * 60 * 1000);
    assert.equal(t.stageTimeoutMs('summarizing'), 10 * 60 * 1000);
  });

  it('the legacy constants facade is gone (focused modules are the only home)', () => {
    assert.equal(
      fs.existsSync('src/shared/constants.ts'),
      false,
      'src/shared/constants.ts must not exist after the closure',
    );
  });

  it('domain job entity has no config/timeout knowledge (single volatility)', () => {
    const src = fs.readFileSync('src/domain/job/entity.ts', 'utf8');
    assert.doesNotMatch(src, /STT_MODEL|LLM_MODEL|dbPath|stageTimeoutMs|STAGE_TIMEOUTS/);
    assert.doesNotMatch(src, /from\s+['"]\.\.\/shared\/config/);
  });

  it('config.ts has no STAGES/STATUS/timeout knowledge (single volatility)', () => {
    const src = fs.readFileSync('src/shared/config.ts', 'utf8');
    assert.doesNotMatch(src, /STAGES|STATUS|Stage\s*=/);
    assert.doesNotMatch(src, /STAGE_TIMEOUTS/);
  });

  it('internal consumers import from focused modules, not the big ball', () => {
    const pipeline = fs.readFileSync('src/application/pipeline-runner.ts', 'utf8');
    // pipeline needs STAGES + stageTimeoutMs + config — should import from focused files
    assert.match(pipeline, /from\s+['"]\.\.\/domain\/job\/entity\.ts['"]/);
    assert.match(pipeline, /from\s+['"]\.\/stage-timeouts\.ts['"]/);
    assert.match(pipeline, /from\s+['"]\.\/config\.ts['"]/);
    assert.doesNotMatch(pipeline, /from\s+['"]\.\.\/shared\/constants\.ts['"]/);

    const db = fs.readFileSync('src/infrastructure/outbound/sqlite/job-store.ts', 'utf8');
    assert.match(db, /from\s+['"]\.\.\/\.\.\/\.\.\/shared\/config\.ts['"]/);
    assert.match(db, /from\s+['"]\.\.\/\.\.\/\.\.\/domain\/job\/entity\.ts['"]/);
    // db should not pull timeouts
    assert.doesNotMatch(db, /from\s+['"]\.\.\/shared\/constants/);
    assert.doesNotMatch(db, /from\s+['"]\.\.\/constants/);
  });
});
