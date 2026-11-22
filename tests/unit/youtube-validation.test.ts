/**
 * Unit tests for the canonical domain YouTube validation (phase 1A).
 * Expected values are literals derived from the spec (README API section)
 * and the issue https://youtu.be/A7w6PDdrWnA — never recomputed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractVideoIdFromUrl, validateYouTubeUrl } from '../../src/domain/youtube/validation.ts';

describe('domain youtube — validateYouTubeUrl accepts canonical forms', () => {
  it('youtu.be short link (issue A7w6PDdrWnA)', () => {
    assert.equal(validateYouTubeUrl('https://youtu.be/A7w6PDdrWnA'), null);
  });

  it('watch URL', () => {
    assert.equal(validateYouTubeUrl('https://www.youtube.com/watch?v=A7w6PDdrWnA'), null);
  });

  it('shorts / embed / v / live paths', () => {
    assert.equal(validateYouTubeUrl('https://www.youtube.com/shorts/A7w6PDdrWnA'), null);
    assert.equal(validateYouTubeUrl('https://www.youtube.com/embed/A7w6PDdrWnA'), null);
    assert.equal(validateYouTubeUrl('https://www.youtube.com/v/A7w6PDdrWnA'), null);
    assert.equal(validateYouTubeUrl('https://www.youtube.com/live/A7w6PDdrWnA'), null);
  });

  it('music / m / www subdomain and nocookie embeds', () => {
    assert.equal(validateYouTubeUrl('https://music.youtube.com/watch?v=A7w6PDdrWnA'), null);
    assert.equal(validateYouTubeUrl('https://m.youtube.com/watch?v=A7w6PDdrWnA'), null);
    assert.equal(validateYouTubeUrl('https://www.youtube-nocookie.com/embed/A7w6PDdrWnA'), null);
  });

  it('youtu.be with query params', () => {
    assert.equal(validateYouTubeUrl('https://youtu.be/A7w6PDdrWnA?si=abc&t=10'), null);
  });
});

describe('domain youtube — validateYouTubeUrl rejects with precise messages', () => {
  it('non-string / empty input', () => {
    assert.equal(validateYouTubeUrl(undefined), 'Enter a YouTube video URL.');
    assert.equal(validateYouTubeUrl(42), 'Enter a YouTube video URL.');
  });

  it('unparseable string', () => {
    assert.equal(validateYouTubeUrl('not a url'), 'Enter a valid YouTube video URL.');
  });

  it('non-http(s) protocol', () => {
    assert.equal(
      validateYouTubeUrl('ftp://youtu.be/A7w6PDdrWnA'),
      'Only youtube.com and youtu.be video URLs are supported.',
    );
  });

  it('non-YouTube host', () => {
    assert.equal(
      validateYouTubeUrl('https://example.com/watch?v=A7w6PDdrWnA'),
      'Only youtube.com and youtu.be video URLs are supported.',
    );
  });

  it('credentials or port in URL', () => {
    assert.equal(
      validateYouTubeUrl('https://user:pass@youtu.be/A7w6PDdrWnA'),
      'This URL contains unsupported credentials or a port.',
    );
    assert.equal(
      validateYouTubeUrl('https://youtu.be:8443/A7w6PDdrWnA'),
      'This URL contains unsupported credentials or a port.',
    );
  });

  it('wrong path on long host', () => {
    assert.equal(
      validateYouTubeUrl('https://www.youtube.com/feed/subscriptions'),
      'Use a standard YouTube watch URL or a youtu.be link.',
    );
  });

  it('bad video id (too short)', () => {
    assert.equal(
      validateYouTubeUrl('https://youtu.be/tooshort'),
      'That URL does not contain a valid single YouTube video ID.',
    );
  });

  it('bad video id (illegal character)', () => {
    assert.equal(
      validateYouTubeUrl('https://youtu.be/A7w6PDdrWn!'),
      'That URL does not contain a valid single YouTube video ID.',
    );
  });

  it('length bound: 2048 chars passes, 2049 fails', () => {
    // Pad the query so the total length hits the bound exactly. The pad
    // chars are all legal, so only the length check can reject it.
    const base = 'https://youtu.be/A7w6PDdrWnA?p=';
    const exact = base + 'x'.repeat(2048 - base.length);
    assert.equal(exact.length, 2048);
    assert.equal(validateYouTubeUrl(exact), null);
    const over = base + 'x'.repeat(2049 - base.length);
    assert.equal(over.length, 2049);
    assert.equal(validateYouTubeUrl(over), 'Enter a YouTube video URL.');
  });
});

describe('domain youtube — extractVideoIdFromUrl', () => {
  it('all canonical forms', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/watch?v=A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/shorts/A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/embed/A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/v/A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/live/A7w6PDdrWnA'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://www.youtube-nocookie.com/embed/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('trims surrounding whitespace (HTTP body / legacy rows)', () => {
    assert.equal(extractVideoIdFromUrl('  https://youtu.be/dQw4w9WgXcQ  '), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('\nhttps://youtu.be/dQw4w9WgXcQ\n'), 'dQw4w9WgXcQ');
  });

  it('youtu.be with query params', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/A7w6PDdrWnA?si=abc123&t=10'), 'A7w6PDdrWnA');
  });

  it('null for non-URLs and bad ids', () => {
    assert.equal(extractVideoIdFromUrl('not a url'), null);
    assert.equal(extractVideoIdFromUrl('https://youtu.be/tooshort'), null);
    assert.equal(extractVideoIdFromUrl('https://example.com/watch?v=A7w6PDdrWnA'), null);
  });
});
