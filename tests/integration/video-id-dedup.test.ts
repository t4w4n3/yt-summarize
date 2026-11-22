/**
 * P2 — Eliminate duplicated extractVideoId (phase 1A: the single source is
 * now src/domain/youtube/validation.ts; infrastructure/inbound/http.ts and infrastructure/outbound/sqlite/job-store.ts
 * delegate to it, so the shared helper handles trimming).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { extractVideoIdFromUrl } from '../../src/infrastructure/outbound/sqlite/job-store.ts';

describe('P2 — shared extractVideoIdFromUrl is the single source', () => {
  it('handles surrounding whitespace (app trims URLs before extraction)', () => {
    // shared helper must be robust to spaces — app currently does value.trim()
    // before constructing URL. After P2, infrastructure/outbound/sqlite/job-store.ts should handle it.
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

  it('infrastructure/inbound/http.ts and infrastructure/outbound/sqlite/job-store.ts delegate to the domain single source', () => {
    const src = fs.readFileSync('src/infrastructure/inbound/http.ts', 'utf8');
    // Should import the domain helper (single source after phase 1A)
    assert.match(src, /from\s+['"]\.\.\/\.\.\/domain\/youtube\/validation\.ts['"]/);
    assert.match(src, /extractVideoIdFromUrl/);
    assert.match(src, /validateYouTubeUrl/);
    // infrastructure/outbound/sqlite/job-store.ts re-exports from the domain (no local copy)
    const dbSrc = fs.readFileSync('src/infrastructure/outbound/sqlite/job-store.ts', 'utf8');
    assert.match(dbSrc, /from\s+['"]\.\.\/\.\.\/\.\.\/domain\/youtube\/validation\.ts['"]/);
    const dbDefs = (dbSrc.match(/function\s+extractVideoIdFromUrl\s*\(/g) || []).length;
    assert.equal(
      dbDefs,
      0,
      'infrastructure/outbound/sqlite/job-store.ts should not define its own extractVideoIdFromUrl — delegate to the domain',
    );
    // Should NOT define a local extractVideoId function anymore
    // (validateYouTubeUrl is allowed to stay — it produces HTTP 400 messages)
    const localDefs = (src.match(/function\s+extractVideoId\s*\(/g) || []).length;
    assert.equal(
      localDefs,
      0,
      'infrastructure/inbound/http.ts should not define its own extractVideoId — reuse the domain',
    );
    // And no local validateYouTubeUrl either: the domain owns the HTTP gate.
    const validateDefs = (src.match(/function\s+validateYouTubeUrl\s*\(/g) || []).length;
    assert.equal(
      validateDefs,
      0,
      'infrastructure/inbound/http.ts should not define its own validateYouTubeUrl — reuse the domain',
    );
  });
});
