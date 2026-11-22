/**
 * Unit tests for normalizeLang (phase 1B). Expected values are literals
 * from the spec: optional two-letter ISO 639-1 code, default 'en'.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeLang } from '../../src/domain/lang.ts';

describe('domain lang — normalizeLang', () => {
  it('absent / blank defaults to en', () => {
    assert.equal(normalizeLang(undefined), 'en');
    assert.equal(normalizeLang(null), 'en');
    assert.equal(normalizeLang(''), 'en');
  });

  it('valid codes pass through, case/space-normalized', () => {
    assert.equal(normalizeLang('fr'), 'fr');
    assert.equal(normalizeLang('en'), 'en');
    assert.equal(normalizeLang(' FR '), 'fr');
  });

  it('non-codes are rejected', () => {
    assert.equal(normalizeLang('fra'), null);
    assert.equal(normalizeLang('f'), null);
    assert.equal(normalizeLang('f1'), null);
    assert.equal(normalizeLang('FR!'), null);
  });

  it('non-strings are rejected', () => {
    assert.equal(normalizeLang(42), null);
    assert.equal(normalizeLang({}), null);
  });
});
