/**
 * Architecture tests — ports/adapters boundaries, run via node:test.
 *
 * Category: arch — enforced by `archunit` (Lukas Niessen's ArchUnitTS).
 * Runs inside `pnpm run test:arch` and the hermetic `pnpm run test` gate;
 * blocked imports fail the test with the exact violating dependency.
 *
 * Conventions under test:
 *  - src/domain/** is pure domain: no imports from application, infrastructure, vpn, or the shared config reader.
 *  - src/application/** is use cases + ports: no imports from infrastructure, vpn,
 *    shared persistence (db), config readers, or stage-timeout readers.
 *  - src/domain/** and src/application/** import no node built-ins.
 *  - The worker bootstrap and polling loop are inbound adapters under
 *    src/infrastructure/inbound/**; the legacy src/worker layer is gone.
 *  - shared is a bottom layer: must not depend upwards into infrastructure/vpn.
 *  - src must not import test fixtures (tests/**, e2e/**).
 *  - tests/unit must target domain/application only — no outbound-adapter imports.
 *
 * Each rule uses the framework-agnostic `check()` API so it works under
 * Node's native `node:test` runner (strict) without Jest/Vitest matchers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { projectFiles } from 'archunit';

function violationMessage(violations: unknown[]): string {
  return violations.map((v: unknown) => JSON.stringify(v, null, 2)).join('\n');
}

const NODE_BUILDIN_IMPORT = /from\s+['"]node:|import\s+['"]node:|import\(\s*['"]node:/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('architecture — layer dependencies (archunit)', () => {
  it('the worker bootstrap and polling loop live in infrastructure/inbound', () => {
    assert.equal(
      fs.existsSync('src/infrastructure/inbound/worker.ts'),
      true,
      'worker bootstrap must be an inbound adapter',
    );
    assert.equal(
      fs.existsSync('src/infrastructure/inbound/worker-core.ts'),
      true,
      'worker polling loop must be an inbound adapter',
    );
    assert.equal(fs.existsSync('src/worker'), false, 'legacy src/worker must be gone after the hexagonal closure');
    assert.equal(fs.existsSync('src/shared/constants.ts'), false, 'the legacy constants facade must be gone');
  });

  it('domain must not depend on inbound adapter', async () => {
    const rule = projectFiles()
      .inFolder('src/domain/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/infrastructure/inbound/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → inbound violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on vpn sidecar', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/vpn/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → vpn violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on storage adapter (shared/db)', async () => {
    const rule = projectFiles()
      .inFolder('src/domain/**')
      .shouldNot()
      .dependOnFiles()
      .inPath('src/infrastructure/outbound/sqlite/job-store.ts');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → storage violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on the application layer', async () => {
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/application/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → application violations:\n${violationMessage(violations)}`);
  });

  it('domain must not depend on the shared config reader', async () => {
    for (const target of ['src/shared/config.ts'] as const) {
      const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inPath(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `domain → ${target} violations:\n${violationMessage(violations)}`);
    }
  });

  it('domain must not depend on infrastructure adapters', async () => {
    // Activates in phase 2 when src/infrastructure/ first exists: archunit
    // reports "no files found" as a violation for an empty target glob.
    if (!fs.existsSync('src/infrastructure')) return;
    const rule = projectFiles().inFolder('src/domain/**').shouldNot().dependOnFiles().inFolder('src/infrastructure/**');
    const violations = await rule.check();
    assert.equal(violations.length, 0, `domain → infrastructure violations:\n${violationMessage(violations)}`);
  });

  it('application must not depend on infrastructure adapters or vpn', async () => {
    // The infrastructure target activates in phase 2 (see above). archunit
    // needs an existing target folder, so skip infrastructure while it does not exist.
    for (const target of ['src/infrastructure/**', 'src/vpn/**'] as const) {
      if (target === 'src/infrastructure/**' && !fs.existsSync('src/infrastructure')) continue;
      const rule = projectFiles().inFolder('src/application/**').shouldNot().dependOnFiles().inFolder(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `application → ${target} violations:\n${violationMessage(violations)}`);
    }
  });

  it('application must not depend on shared persistence or config readers', async () => {
    for (const target of ['src/infrastructure/outbound/sqlite/job-store.ts', 'src/shared/config.ts'] as const) {
      const rule = projectFiles().inFolder('src/application/**').shouldNot().dependOnFiles().inPath(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `application → ${target} violations:\n${violationMessage(violations)}`);
    }
  });

  it('shared must not depend upwards on infrastructure or vpn', async () => {
    for (const target of ['src/infrastructure/**', 'src/vpn/**'] as const) {
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
    const folderTargets = ['src/infrastructure/**', 'src/vpn/**'] as const;
    for (const target of folderTargets) {
      const rule = projectFiles().inFolder('tests/unit/**').shouldNot().dependOnFiles().inFolder(target);
      const violations = await rule.check();
      assert.equal(violations.length, 0, `tests/unit → ${target} violations:\n${violationMessage(violations)}`);
    }
    const dbRule = projectFiles()
      .inFolder('tests/unit/**')
      .shouldNot()
      .dependOnFiles()
      .inPath('src/infrastructure/outbound/sqlite/job-store.ts');
    const dbViolations = await dbRule.check();
    assert.equal(
      dbViolations.length,
      0,
      `tests/unit → src/infrastructure/outbound/sqlite/job-store.ts violations:\n${violationMessage(dbViolations)}`,
    );
  });

  it('src is free of cyclic dependencies', async () => {
    const rule = projectFiles().inFolder('src/**').should().haveNoCycles();
    const violations = await rule.check();
    assert.equal(violations.length, 0, `cycles in src/**:\n${violationMessage(violations)}`);
  });

  it('domain and application import no node built-ins', () => {
    const offenders: string[] = [];
    for (const dir of ['domain', 'application'] as const) {
      for (const file of tsFilesUnder(path.join('src', dir))) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const [index, line] of lines.entries()) {
          if (NODE_BUILDIN_IMPORT.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `domain/application must be portable pure code; node: built-ins belong to adapters:\n${offenders.join('\n')}`,
    );
  });
});
