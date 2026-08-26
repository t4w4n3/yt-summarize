/**
 * P2 — Eliminate duplicated extractVideoId.
 * This test enforces that app/server.ts reuses shared/db.ts via contract
 * and that the shared helper handles trimming (the app's URL comes .trim()'d).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { extractVideoIdFromUrl } from '../../src/shared/db.ts';

describe('P2 — shared extractVideoIdFromUrl is the single source', () => {
  it('handles surrounding whitespace (app trims URLs before extraction)', () => {
    // shared helper must be robust to spaces — app currently does value.trim()
    // before constructing URL. After P2, shared/db.ts should handle it.
    assert.equal(extractVideoIdFromUrl('  https://youtu.be/dQw4w9WgXcQ  '), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl(' https://www.youtube.com/watch?v=dQw4w9WgXcQ '), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('\nhttps://youtu.be/dQw4w9WgXcQ\n'), 'dQw4w9WgXcQ');
  });

  it('still extracts canonical youtube.com and youtu.be forms', () => {
    assert.equal(extractVideoIdFromUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoIdFromUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('app/server.ts reuses shared helper instead of duplicating', () => {
    const src = fs.readFileSync('src/app/server.ts', 'utf8');
    // Should import the shared helper
    assert.match(src, /from\s+['"]\.\.\/shared\/db\.ts['"]/);
    assert.match(src, /extractVideoIdFromUrl/);
    // Should NOT define a local extractVideoId function anymore
    // (validateYouTubeUrl is allowed to stay — it produces HTTP 400 messages)
    const localDefs = (src.match(/function\s+extractVideoId\s*\(/g) || []).length;
    assert.equal(localDefs, 0, 'app/server.ts should not define its own extractVideoId — reuse shared/db.ts');
  });
});
