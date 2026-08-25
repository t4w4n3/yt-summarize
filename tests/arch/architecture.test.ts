/**
 * Architecture tests — ports/adapters boundaries, run via node:test.
 *
 * Category: arch — enforced by `archunit` (Lukas Niessen's ArchUnitTS).
 * Runs inside `pnpm run test:arch` and the hermetic `pnpm run test` gate;
 * blocked imports fail the test with the exact violating dependency.
 *
 * Conventions under test:
 *  - src/domain/** is pure domain: no imports from worker/app/vpn/shared adapters.
 *  - src/app (inbound adapter) must not reach into worker internals.
 *  - shared is a bottom layer: must not depend upwards into app/worker/vpn.
 *  - src must not import test fixtures (tests/**, e2e/**).
 *  - tests/unit must target domain only — no outbound-adapter imports.
 *
 * Each rule uses the framework-agnostic `check()` API so it works under
 * Node's native `node:test` runner (strict) without Jest/Vitest matchers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectFiles } from 'archunit';

function violationMessage(violations: unknown[]): string {
  return violations.map((v: unknown) => JSON.stringify(v, null, 2)).join('\n');
}

describe('architecture — layer dependencies (archunit)', () => {
  it('domain must not depend on worker / app / vpn adapters', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/worker/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → worker violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on app (inbound adapter)', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/app/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → app violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on vpn sidecar', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/vpn/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → vpn violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on storage adapter (shared/db)', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inPath('src/shared/db.ts');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → shared/db violations:\n${violationMessage(violations)}`);
  });

  it('app (inbound) must not depend on worker internals', async () => {
    const rule = projectFiles().inFolder('src/app/**').shouldNot().dependOnFiles().inFolder('src/worker/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `app → worker violations:\n${violationMessage(violations)}`);
  });

  it('shared must not depend upwards on app / worker / vpn', async () => {
    for (const target of ['src/app/**', 'src/worker/**', 'src/vpn/**'] as const) {
      const rule = projectFiles().inFolder('src/shared/**').shouldNot().dependOnFiles().inFolder(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `shared → ${target} violations:\n${violationMessage(violations)}`);
    }
  });

  it('src must not import test fixtures or e2e helpers', async () => {
    for (const folder of ['tests/**', 'e2e/**'] as const) {
      const rule = projectFiles().inFolder('src/**').shouldNot().dependOnFiles().inFolder(folder);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `src → ${folder} violations:\n${violationMessage(violations)}`);
    }
  });

  it('unit tests (domain use cases) must not import outbound adapters', async () => {
    // Fakes over mocks — unit tests drive the domain through ports (pure fns
    // or an in-memory fake port), not through the real outbound adapters.
    // inFolder expects folder globs; use inPath for exact files like db.ts.
    const folderTargets = ['src/worker/**', 'src/vpn/**', 'src/app/**'] as const;
    for (const target of folderTargets) {
      const rule = projectFiles().inFolder('tests/unit/**').shouldNot().dependOnFiles().inFolder(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `tests/unit → ${target} violations:\n${violationMessage(violations)}`);
    }
    const dbRule = projectFiles().inFolder('tests/unit/**').shouldNot().dependOnFiles().inPath('src/shared/db.ts');
    const dbViolations = await dbRule.check();
    assert.equal(
      dbViolations.length,
      0,
      `tests/unit → src/shared/db.ts violations:\n${violationMessage(dbViolations)}`,
    );
  });

  it('src is free of cyclic dependencies', async () => {
    const rule = projectFiles().inFolder('src/**').should().haveNoCycles();
    const violations = await rule.check();
    assert.equal(violations.length, 0, `cycles in src/**:\n${violationMessage(violations)}`);
  });
});
