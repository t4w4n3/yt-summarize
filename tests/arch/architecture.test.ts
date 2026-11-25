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

  it('image entrypoints only reference node modules that exist in the image', () => {
    // The Dockerfile copies src/ to /app/src/, so a `node /app/...` path in an
    // entrypoint must map to an existing file — a moved adapter that forgets
    // its entrypoint ships a container that exits MODULE_NOT_FOUND at boot.
    const missing: string[] = [];
    for (const entry of fs.readdirSync('image', { withFileTypes: true })) {
      if (!entry.name.startsWith('entrypoint-') || !entry.name.endsWith('.sh')) continue;
      const content = fs.readFileSync(path.join('image', entry.name), 'utf8');
      for (const match of content.matchAll(/node\s+(\/app\/\S+\.ts)/g)) {
        const target = (match[1] ?? '').replace(/^\/app\//, '');
        if (!fs.existsSync(target)) missing.push(`${entry.name}: node ${match[1]} → ${target} does not exist`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `every node entry in image/entrypoint-*.sh must point at a file copied into the image ` +
        `(Dockerfile COPY src/ → /app/src/):\n${missing.join('\n')}`,
    );
  });

  it('image entrypoints run the same modules as the package.json start scripts', () => {
    // Existence alone is not enough: pointing the app container at worker.ts
    // would still "exist" while polling jobs instead of serving HTTP. The
    // shell entrypoint and its package.json start script are two names for
    // the same process entry, so they must never drift apart.
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    const cases = [['image/entrypoint-worker.sh', pkg.scripts?.['start:worker']]] as const;
    const mismatches: string[] = [];
    for (const [entrypoint, script] of cases) {
      const fromScript = script?.match(/node\s+(\S+\.ts)/)?.[1];
      const fromEntrypoint = fs.readFileSync(entrypoint, 'utf8').match(/node\s+\/app\/(\S+\.ts)/)?.[1];
      if (fromEntrypoint !== fromScript) {
        mismatches.push(
          `${entrypoint}: runs ${fromEntrypoint ?? '(none)'} but package.json runs ${fromScript ?? '(none)'}`,
        );
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `an entrypoint and its package.json start script must launch the same module:\n${mismatches.join('\n')}`,
    );
  });

  it('Dockerfile splits into per-service targets with least-privilege tools', () => {
    const dockerfile = fs.readFileSync('image/Dockerfile', 'utf8');
    const fromPattern = /^FROM\s+\S+(?:\s+AS\s+(\w+))?/gim;
    const matches = [...dockerfile.matchAll(fromPattern)];
    const stages = new Map<string, string>();
    for (let i = 0; i < matches.length; i += 1) {
      const matched = matches[i];
      const name = matched?.[1] ?? '(unnamed)';
      const start = matched?.index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? dockerfile.length) : dockerfile.length;
      stages.set(name, dockerfile.slice(start, end));
    }
    assert.deepEqual(
      [...stages.keys()].sort(),
      ['app', 'base', 'vpn', 'worker'],
      'Dockerfile must define base+app+worker+vpn stages (one Dockerfile, three images)',
    );
    const app = stages.get('app') ?? '';
    const worker = stages.get('worker') ?? '';
    const vpn = stages.get('vpn') ?? '';
    assert.equal(
      app.includes('distroless/nodejs26-debian13'),
      true,
      'app stage: expected distroless nodejs26 runtime (zero shell, zero curl)',
    );
    assert.equal(
      app.includes('ENTRYPOINT ["/nodejs/bin/node"]'),
      true,
      'app stage: expected node ENTRYPOINT (no shell entrypoint)',
    );
    assert.equal(
      app.includes('CMD ["/app/src/infrastructure/inbound/http.ts"]'),
      true,
      'app stage: expected default CMD http.ts (compose can override CMD for the fake worker)',
    );
    assert.equal(app.includes('USER 1000'), true, 'app stage: expected numeric USER 1000 (shared data volume uid)');
    assert.equal(worker.includes('ffmpeg='), true, 'worker stage: expected ffmpeg package for convert/transcribe');
    assert.equal(worker.includes('python3='), true, 'worker stage: expected python3 for yt-dlp');
    assert.equal(worker.includes('yt-dlp=='), true, 'worker stage: expected yt-dlp install for download stage');
    assert.equal(worker.includes('gnupg='), true, 'worker stage: expected gnupg for legacy secret decrypt');
    assert.equal(vpn.includes('wireguard-tools='), true, 'vpn stage: expected wireguard-tools for wg-quick');
    assert.equal(vpn.includes('iproute2='), true, 'vpn stage: expected iproute2 for wg-quick ip calls');
    assert.equal(app.includes('ffmpeg='), false, 'app stage: must not install ffmpeg (HTTP+SQLite only)');
    assert.equal(app.includes('python3='), false, 'app stage: must not install python3 (no yt-dlp)');
    assert.equal(app.includes('wireguard-tools='), false, 'app stage: must not install wireguard-tools');
    assert.equal(app.includes('curl='), false, 'app stage: must not install curl (distroless has none)');
    assert.equal(app.includes('apt-get'), false, 'app stage: must not install anything at runtime (distroless)');
    assert.equal(
      app.includes('entrypoint-app.sh'),
      false,
      'app stage: must not ship a shell entrypoint (distroless has no shell)',
    );
    assert.equal(worker.includes('wireguard-tools='), false, 'worker stage: must not install wireguard-tools');
    assert.equal(worker.includes('iproute2='), false, 'worker stage: must not install iproute2');
    assert.equal(vpn.includes('ffmpeg='), false, 'vpn stage: must not install ffmpeg (SOCKS5 only)');
    assert.equal(vpn.includes('python3='), false, 'vpn stage: must not install python3 (no yt-dlp)');
    const compose = fs.readFileSync('compose.yaml', 'utf8');
    assert.equal(compose.includes('curl'), false, 'compose: must not use curl (distroless app has none)');
    assert.equal(
      compose.includes('test: ["CMD", "/nodejs/bin/node", "/app/src/infrastructure/inbound/healthcheck.ts"'),
      true,
      'compose: expected CMD healthcheck via healthcheck.ts (podman-compose JSON keeps it shell-less)',
    );
    assert.equal(
      fs.existsSync('src/infrastructure/inbound/healthcheck.ts'),
      true,
      'healthcheck.ts: must exist for the distroless probe',
    );
    assert.equal(
      compose.includes('user: "1000"'),
      true,
      'compose app: expected numeric user "1000" (no node user in distroless)',
    );
    assert.equal(
      compose.includes('entrypoint-app.sh'),
      false,
      'compose: must not run the shell entrypoint (distroless app has no shell)',
    );
    assert.equal(compose.includes('target: "app"'), true, 'compose app: expected target "app" build');
    assert.equal(compose.includes('target: "worker"'), true, 'compose worker: expected target "worker" build');
    assert.equal(compose.includes('target: "vpn"'), true, 'compose vpn: expected target "vpn" build');
    const mullvad = fs.readFileSync('.mise/tasks/mullvad.sh', 'utf8');
    assert.equal(
      mullvad.includes('summarize-yt_vpn'),
      true,
      'mullvad pick_image: expected vpn image (only target with wg-quick)',
    );
    const e2eCompose = fs.readFileSync('e2e/compose.e2e.yaml', 'utf8');
    assert.equal(
      e2eCompose.includes('target: "app"'),
      true,
      'e2e compose: expected app target (distroless node) for the fake worker healthcheck',
    );
    assert.equal(e2eCompose.includes('curl'), false, 'e2e compose: must not use curl (distroless app has none)');
    assert.equal(e2eCompose.includes('fetch('), false, 'e2e compose: must not inline fetch (becomes CMD-SHELL)');
    assert.equal(e2eCompose.includes('test:'), true, 'e2e compose: expected a healthcheck test for the fake worker');
    assert.equal(
      e2eCompose.includes(
        '"/nodejs/bin/node", "/app/src/infrastructure/inbound/healthcheck.ts", "http://127.0.0.1:4175/healthz"',
      ),
      true,
      'e2e compose: expected CMD healthcheck via healthcheck.ts for the fake worker (formatting-agnostic)',
    );
    assert.equal(
      e2eCompose.includes('entrypoint-app.sh'),
      false,
      'e2e compose: must not run the shell entrypoint (distroless app has no shell)',
    );
    assert.equal(
      fs.existsSync('image/entrypoint-app.sh'),
      false,
      'image/entrypoint-app.sh: must be deleted, distroless app runs node directly',
    );
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
