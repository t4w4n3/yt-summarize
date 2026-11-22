import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stageTimeoutMs } from '../../src/application/stage-timeouts.ts';

describe('application/stage-timeouts — injected fallback', () => {
  it('uses the injected jobTimeoutMs only for an unknown stage', () => {
    assert.equal(stageTimeoutMs('mystery', 789), 789, 'unknown stage must use the injected fallback 789ms');
    assert.equal(stageTimeoutMs('downloading', 789), 10 * 60 * 1000, 'downloading keeps the fixed 10min ceiling');
  });
});
