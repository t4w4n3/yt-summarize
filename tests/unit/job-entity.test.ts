/**
 * Unit tests for the rich Job entity and the dedup policy (phase 1C).
 * All expected values are independent literals (lifecycle mirrors the
 * shared-DB contract in tests/integration/db-lifecycle.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEDUP_STATUSES, dedupKey, dedupRank, isDedupEligibleStatus } from '../../src/domain/job/dedup.ts';
import {
  claimJob,
  createJobEntity,
  heartbeatJob,
  InvalidJobTransitionError,
  isStaleJob,
  type Job,
  markJobDone,
  markJobFailed,
  retryJob,
  updateJobStage,
} from '../../src/domain/job/entity.ts';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:10.000Z';
const T2 = '2026-01-01T00:00:20.000Z';

function queuedJob(): Job {
  return createJobEntity({ id: 'j1', url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', lang: 'fr' }, T0);
}

function runningJob(): Job {
  return claimJob(queuedJob(), T0);
}

describe('domain job entity — create', () => {
  it('new job is queued at progress 0 with empty leases', () => {
    const job = queuedJob();
    assert.equal(job.status, 'queued');
    assert.equal(job.progress, 0);
    assert.equal(job.stage, null);
    assert.equal(job.title, null);
    assert.equal(job.error, null);
    assert.equal(job.markdown, null);
    assert.equal(job.claimedAt, null);
    assert.equal(job.lastHeartbeatAt, null);
    assert.equal(job.createdAt, T0);
    assert.equal(job.updatedAt, T0);
  });

  it('videoId/lang default to null (legacy NULL reads as en later)', () => {
    const job = createJobEntity({ id: 'j2', url: 'https://youtu.be/dQw4w9WgXcQ' }, T0);
    assert.equal(job.videoId, null);
    assert.equal(job.lang, null);
  });
});

describe('domain job entity — lifecycle transitions', () => {
  it('claim moves queued → running with a fresh lease', () => {
    const job = claimJob(queuedJob(), T1);
    assert.equal(job.status, 'running');
    assert.equal(job.stage, null);
    assert.equal(job.progress, 0);
    assert.equal(job.claimedAt, T1);
    assert.equal(job.lastHeartbeatAt, T1);
    assert.equal(job.updatedAt, T1);
  });

  it('claim of a running job throws', () => {
    assert.throws(() => claimJob(runningJob(), T1), InvalidJobTransitionError);
  });

  it('heartbeat refreshes lastHeartbeatAt on running jobs only', () => {
    const job = heartbeatJob(runningJob(), T2);
    assert.equal(job.status, 'running');
    assert.equal(job.lastHeartbeatAt, T2);
    assert.equal(job.updatedAt, T2);
    assert.throws(() => heartbeatJob(queuedJob(), T1), InvalidJobTransitionError);
  });

  it('updateJobStage sets stage/progress on running only, bounded 0..100', () => {
    const job = updateJobStage(runningJob(), 'transcribing', 100, T2);
    assert.equal(job.stage, 'transcribing');
    assert.equal(job.progress, 100);
    assert.throws(() => updateJobStage(runningJob(), 'converting', 101, T2), RangeError);
    assert.throws(() => updateJobStage(queuedJob(), 'converting', 10, T2), InvalidJobTransitionError);
  });

  it('markDone: running → done, progress 100, keeps title+markdown', () => {
    const job = markJobDone(updateJobStage(runningJob(), 'summarizing', 70, T1), 'Title', '# Note', T2);
    assert.equal(job.status, 'done');
    assert.equal(job.progress, 100);
    assert.equal(job.stage, null);
    assert.equal(job.title, 'Title');
    assert.equal(job.markdown, '# Note');
    assert.equal(job.error, null);
    assert.equal(job.lastHeartbeatAt, null);
    assert.throws(() => markJobDone(queuedJob(), 'T', '# N', T1), InvalidJobTransitionError);
  });

  it('markFailed: running → failed records error+stage, clears lease', () => {
    const job = markJobFailed(runningJob(), 'boom', 'transcribing', T2);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'boom');
    assert.equal(job.stage, 'transcribing');
    assert.equal(job.lastHeartbeatAt, null);
    assert.throws(() => markJobFailed(queuedJob(), 'boom', null, T1), InvalidJobTransitionError);
  });

  it('retry re-queues a failed job and clears the failure state', () => {
    const failed = markJobFailed(updateJobStage(runningJob(), 'summarizing', 70, T1), 'boom', 'summarizing', T1);
    const retried = retryJob(failed, T2);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.error, null);
    assert.equal(retried.stage, null);
    assert.equal(retried.progress, 0);
    assert.equal(retried.claimedAt, null);
    assert.equal(retried.lastHeartbeatAt, null);
    // Identity survives a retry: url/videoId/lang/title are untouched.
    assert.equal(retried.url, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(retried.videoId, 'dQw4w9WgXcQ');
    assert.equal(retried.lang, 'fr');
    assert.throws(() => retryJob(queuedJob(), T1), InvalidJobTransitionError);
  });

  it('transitions are pure: the input job is never mutated', () => {
    const original = queuedJob();
    claimJob(original, T1);
    assert.equal(original.status, 'queued');
    assert.equal(original.claimedAt, null);
  });
});

describe('domain job entity — isStaleJob boundary', () => {
  it('running job is stale exactly past the threshold, not at it', () => {
    const staleAfterMs = 600_000; // 10 min, mirrors STALE_AFTER_MS default
    const nowMs = Date.parse(T2); // 20s after T0
    // Activity at T1 (10s ago) with a 10s window: exactly at cutoff → not stale.
    const atCutoff = claimJob(queuedJob(), T1);
    assert.equal(isStaleJob(atCutoff, nowMs, 10_000), false);
    // Activity 1ms older than the cutoff → stale.
    const older = claimJob(queuedJob(), '2026-01-01T00:00:09.999Z');
    assert.equal(isStaleJob(older, nowMs, 10_000), true);
    // Claim at T0 (20s ago) with a 10min window → not stale.
    assert.equal(isStaleJob(claimJob(queuedJob(), T0), nowMs, staleAfterMs), false);
  });

  it('non-running jobs are never stale', () => {
    assert.equal(isStaleJob(queuedJob(), Date.parse(T2), 1), false);
    const done = markJobDone(runningJob(), 'T', '# N', T1);
    assert.equal(isStaleJob(done, Date.parse(T2), 1), false);
  });
});

describe('domain job — dedup policy', () => {
  it('eligible statuses are queued/running/done (not failed)', () => {
    assert.deepEqual([...DEDUP_STATUSES], ['queued', 'running', 'done']);
    assert.equal(isDedupEligibleStatus('queued'), true);
    assert.equal(isDedupEligibleStatus('running'), true);
    assert.equal(isDedupEligibleStatus('done'), true);
    assert.equal(isDedupEligibleStatus('failed'), false);
  });

  it('preference order: done before running before queued', () => {
    assert.equal(dedupRank('done'), 0);
    assert.equal(dedupRank('running'), 1);
    assert.equal(dedupRank('queued'), 2);
    assert.ok(dedupRank('done') < dedupRank('running'));
    assert.ok(dedupRank('running') < dedupRank('queued'));
  });

  it('dedup key: same video+lang collide, NULL lang counts as en', () => {
    assert.equal(dedupKey('dQw4w9WgXcQ', 'fr'), 'dQw4w9WgXcQ|fr');
    assert.equal(dedupKey('dQw4w9WgXcQ', null), 'dQw4w9WgXcQ|en');
    assert.equal(dedupKey('dQw4w9WgXcQ', null), dedupKey('dQw4w9WgXcQ', 'en'));
    assert.notEqual(dedupKey('dQw4w9WgXcQ', 'fr'), dedupKey('dQw4w9WgXcQ', 'en'));
    assert.equal(dedupKey(null, 'fr'), null);
  });
});
