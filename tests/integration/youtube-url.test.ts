import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractVideoIdFromUrl } from '../../src/shared/db.ts';

/**
 * Regression for https://youtu.be/A7w6PDdrWnA
 * This valid youtu.be link was rejected with "The string did not match the expected pattern."
 * The test below should pass for this URL and for other canonical YouTube forms
 * (shorts, embed, v, live) that yt-dlp handles but our validator rejected.
 */

describe('youtube url validation — bug https://youtu.be/A7w6PDdrWnA', () => {
  it('extracts youtu.be/A7w6PDdrWnA', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts www.youtube.com/watch?v=A7w6PDdrWnA', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/watch?v=A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts shorts URL', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/shorts/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts embed URL', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/embed/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts v URL', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/v/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts live URL', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/live/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });

  it('extracts youtu.be with query params (si, t)', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/A7w6PDdrWnA?si=abc123&t=10'), 'A7w6PDdrWnA');
    assert.equal(extractVideoIdFromUrl('https://youtu.be/A7w6PDdrWnA?feature=share'), 'A7w6PDdrWnA');
  });

  it('extracts youtube-nocookie embed', () => {
    assert.equal(extractVideoIdFromUrl('https://www.youtube-nocookie.com/embed/A7w6PDdrWnA'), 'A7w6PDdrWnA');
  });
});
