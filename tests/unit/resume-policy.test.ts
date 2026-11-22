/**
 * Unit tests for decideResumePoint (phase 1E). All 8 probe combinations;
 * the rule is "furthest valid artifact wins".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ArtifactProbe, decideResumePoint } from '../../src/application/resume-policy.ts';

function probe(partial: Partial<ArtifactProbe>): ArtifactProbe {
  return { hasTranscript: false, hasWav: false, hasDownloadedAudio: false, ...partial };
}

describe('application — decideResumePoint', () => {
  it('nothing on disk → start from the beginning', () => {
    assert.equal(decideResumePoint(probe({})), null);
  });

  it('transcript always wins (furthest artifact)', () => {
    assert.equal(decideResumePoint(probe({ hasTranscript: true })), 'summarizing');
    assert.equal(decideResumePoint(probe({ hasTranscript: true, hasWav: true })), 'summarizing');
    assert.equal(
      decideResumePoint(probe({ hasTranscript: true, hasWav: true, hasDownloadedAudio: true })),
      'summarizing',
    );
  });

  it('wav wins over downloaded audio', () => {
    assert.equal(decideResumePoint(probe({ hasWav: true })), 'transcribing');
    assert.equal(decideResumePoint(probe({ hasWav: true, hasDownloadedAudio: true })), 'transcribing');
  });

  it('downloaded audio alone → converting', () => {
    assert.equal(decideResumePoint(probe({ hasDownloadedAudio: true })), 'converting');
  });
});
