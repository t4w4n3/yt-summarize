// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the un-interpolated
// "${VAR:-default}" expression podman-compose emits IS the input under test.
/**
 * Unit tests — reading settings out of the environment.
 *
 * Category: unit — pure parsing plus one small runtime lookup, no adapters.
 *
 * Why these exist: podman-compose 1.3.0 hands the container the raw expression
 * `${VAR:-default}` when VAR is absent from `.env` (proved with
 * `podman-compose config`). A reader that does not know that gets the literal
 * string — `MULLVAD_ENABLED === 'true'` is then false and the VPN silently goes
 * direct. The expression carries the default written in compose.yaml, so that
 * is what a missing variable must resolve to; a bare `${VAR}` means unset.
 *
 * Run: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config, envBool, envVar, mullvadSettings, unwrapComposeLiteral } from '../../src/shared/config.ts';

describe('shared/config — unwrapComposeLiteral', () => {
  it('returns the default written inside ${VAR:-default}', () => {
    assert.equal(unwrapComposeLiteral('${MULLVAD_ENABLED:-true}'), 'true');
    assert.equal(unwrapComposeLiteral('${STT_RETRY_MAX_ATTEMPTS:-3}'), '3');
    assert.equal(unwrapComposeLiteral('${MULLVAD_PROXY:-socks5h://127.0.0.1:1080}'), 'socks5h://127.0.0.1:1080');
  });

  it('treats a bare expression as unset', () => {
    assert.equal(unwrapComposeLiteral('${MULLVAD_ENABLED}'), undefined);
  });

  it('keeps an empty default as an empty string', () => {
    assert.equal(unwrapComposeLiteral('${VAR:-}'), '');
  });

  it('leaves ordinary values untouched', () => {
    assert.equal(unwrapComposeLiteral('true'), 'true');
    assert.equal(unwrapComposeLiteral('microsoft/mai-transcribe-2'), 'microsoft/mai-transcribe-2');
    assert.equal(unwrapComposeLiteral(''), '');
    // Only a whole-value expression is unwrapped, never a fragment
    assert.equal(unwrapComposeLiteral('a${B:-c}d'), 'a${B:-c}d');
    assert.equal(unwrapComposeLiteral('${not a name:-x}'), '${not a name:-x}');
    assert.equal(unwrapComposeLiteral('${VAR:-unterminated'), '${VAR:-unterminated');
  });
});

describe('shared/config — envVar', () => {
  it('uses the fallback when the variable is absent or blank', () => {
    assert.equal(envVar(undefined, 'code-default'), 'code-default');
    assert.equal(envVar('', 'code-default'), 'code-default');
    assert.equal(envVar('   ', 'code-default'), 'code-default');
  });

  it('uses the literal default the compose expression carries, not the code fallback', () => {
    assert.equal(envVar('${STT_MODEL:-microsoft/mai-transcribe-2}', 'code-default'), 'microsoft/mai-transcribe-2');
  });

  it('uses the fallback for a bare expression', () => {
    assert.equal(envVar('${STT_MODEL}', 'code-default'), 'code-default');
  });

  it('returns a real value as-is', () => {
    assert.equal(envVar('meta/muse-spark-1.3-contributor', 'code-default'), 'meta/muse-spark-1.3-contributor');
  });
});

describe('shared/config — envBool', () => {
  it('reads true and false as written', () => {
    assert.equal(envBool('true', false), true);
    assert.equal(envBool('false', true), false);
  });

  it('falls back when absent, blank or unrecognised', () => {
    assert.equal(envBool(undefined, false), false);
    assert.equal(envBool(undefined, true), true);
    assert.equal(envBool('', true), true);
    assert.equal(envBool('1', false), false);
    assert.equal(envBool('yes', false), false);
  });

  it('honours the default carried by the compose expression', () => {
    assert.equal(envBool('${MULLVAD_ENABLED:-true}', false), true);
    assert.equal(envBool('${MULLVAD_ENABLED:-false}', true), false);
    assert.equal(envBool('${MULLVAD_ENABLED}', true), true);
  });
});

describe('shared/config — mullvadSettings', () => {
  const originalEnabled = process.env.MULLVAD_ENABLED;
  const originalProxy = process.env.MULLVAD_PROXY;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.MULLVAD_ENABLED;
    else process.env.MULLVAD_ENABLED = originalEnabled;
    if (originalProxy === undefined) delete process.env.MULLVAD_PROXY;
    else process.env.MULLVAD_PROXY = originalProxy;
  });

  it('is off with the sidecar proxy when nothing is configured', () => {
    delete process.env.MULLVAD_ENABLED;
    delete process.env.MULLVAD_PROXY;
    assert.deepEqual(mullvadSettings(), { enabled: false, proxy: 'socks5h://127.0.0.1:1080' });
  });

  it('keeps the tunnel on when podman-compose passes the raw expression (regression)', () => {
    // Exactly what the deployed worker receives when MULLVAD_ENABLED is not in .env
    process.env.MULLVAD_ENABLED = '${MULLVAD_ENABLED:-true}';
    process.env.MULLVAD_PROXY = '${MULLVAD_PROXY:-socks5h://127.0.0.1:1080}';
    assert.deepEqual(mullvadSettings(), { enabled: true, proxy: 'socks5h://127.0.0.1:1080' });
  });

  it('honours an explicit proxy and an explicit disable', () => {
    process.env.MULLVAD_ENABLED = 'true';
    process.env.MULLVAD_PROXY = 'socks5h://custom:1080';
    assert.deepEqual(mullvadSettings(), { enabled: true, proxy: 'socks5h://custom:1080' });

    process.env.MULLVAD_ENABLED = 'false';
    assert.equal(mullvadSettings().enabled, false);
  });
});

describe('shared/config — the frozen config object is fully resolved', () => {
  // Guards the module's evaluation order: `config` is built at import time, so
  // anything it calls (helpers, their regex constants) must already exist.
  // A temporal-dead-zone crash here is invisible to tests that only exercise
  // the helpers directly.
  it('every numeric setting is a finite positive number', () => {
    const numeric = {
      port: config.port,
      sttRetryMaxAttempts: config.sttRetryMaxAttempts,
      pollMs: config.pollMs,
      jobTimeoutMs: config.jobTimeoutMs,
      staleAfterMs: config.staleAfterMs,
    } as const;
    for (const [name, value] of Object.entries(numeric)) {
      assert.ok(Number.isFinite(value) && value >= 1, `${name}=${value} must be a finite bound ≥ 1`);
    }
    assert.ok(
      Number.isFinite(config.sttRetryBaseDelayMs) && config.sttRetryBaseDelayMs >= 0,
      'base delay is a finite bound',
    );
    assert.ok(
      Number.isFinite(config.sttRetryMaxDelayMs) && config.sttRetryMaxDelayMs >= 0,
      'max delay is a finite bound',
    );
  });

  it('no string setting leaks an un-parsed compose expression', () => {
    const strings = {
      dataDir: config.dataDir,
      artifactsDir: config.artifactsDir,
      sttModel: config.sttModel,
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
      llmThinking: config.llmThinking,
      mullvadProxy: mullvadSettings().proxy,
    } as const;
    for (const [name, value] of Object.entries(strings)) {
      assert.ok(
        value.length > 0 && !value.startsWith('${'),
        `${name}=${JSON.stringify(value)} must be a resolved value`,
      );
    }
  });
});
