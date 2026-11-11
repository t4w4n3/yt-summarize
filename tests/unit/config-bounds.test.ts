// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the un-interpolated
// "${VAR:-default}" expression podman-compose emits IS the input under test.
/**
 * Unit tests — integer bounds read from the environment.
 *
 * Category: unit — pure parsing, no adapters.
 *
 * Why these exist: podman-compose 1.3.0 does not interpolate the default of a
 * variable that is absent from `.env` — the worker receives the literal
 * `${STT_RETRY_MAX_ATTEMPTS:-3}`. `Number(...)` turns that into NaN, and a NaN
 * attempt count silently disables the retry loop (`n < NaN` is false). A bound
 * must therefore always resolve to a usable number.
 *
 * Run: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundedInt } from '../../src/shared/config.ts';

describe('shared/config — boundedInt', () => {
  it('uses the fallback when the variable is absent', () => {
    assert.equal(boundedInt(undefined, 3, 1), 3);
  });

  it('uses the fallback for the un-interpolated compose literal', () => {
    // Exactly what podman-compose passes when the var is missing from .env —
    // the `${` is the input under test, not a template to interpolate.
    const attemptsLiteral = '${STT_RETRY_MAX_ATTEMPTS:-3}';
    const baseLiteral = '${STT_RETRY_BASE_DELAY_MS:-1000}';
    assert.equal(boundedInt(attemptsLiteral, 3, 1), 3);
    assert.equal(boundedInt(baseLiteral, 1000, 0), 1000);
  });

  it('parses a plain integer', () => {
    assert.equal(boundedInt('5', 3, 1), 5);
    assert.equal(boundedInt('8000', 1000, 0), 8000);
  });

  it('honours the default carried by the compose expression over the code fallback', () => {
    assert.equal(boundedInt('${STT_RETRY_MAX_ATTEMPTS:-42}', 3, 1), 42);
  });

  it('floors a decimal and trims surrounding spaces', () => {
    assert.equal(boundedInt('5.9', 3, 1), 5);
    assert.equal(boundedInt(' 7 ', 3, 1), 7);
  });

  it('treats an empty or blank value as unset, never as zero', () => {
    assert.equal(boundedInt('', 1000, 0), 1000);
    assert.equal(boundedInt('   ', 8000, 0), 8000);
  });

  it('uses the fallback for unparsable input rather than propagating NaN', () => {
    assert.equal(boundedInt('', 3, 1), 3);
    assert.equal(boundedInt('abc', 3, 1), 3);
    assert.equal(boundedInt('Infinity', 3, 1), 3);
    assert.equal(boundedInt('NaN', 3, 1), 3);
  });

  it('uses the fallback below the minimum', () => {
    assert.equal(boundedInt('0', 3, 1), 3);
    assert.equal(boundedInt('-2', 3, 1), 3);
    // A zero delay is legitimate where the minimum allows it
    assert.equal(boundedInt('0', 1000, 0), 0);
  });
});
