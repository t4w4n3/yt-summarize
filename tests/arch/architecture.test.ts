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

  it('the worker entrypoint (Node, no shell) runs the same module as the start:worker script', () => {
    // Compose runs the Node entrypoint directly (no shell in the boot path):
    // directly, and that entrypoint must import the same worker.ts that
    // `pnpm start:worker` runs, otherwise the container polls a different
    // (or no) pipeline than local dev.
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    const fromScript = pkg.scripts?.['start:worker']?.match(/node\s+(\S+\.ts)/)?.[1];
    const compose = fs.readFileSync('compose.yaml', 'utf8');
    const fromCompose = compose.match(/entrypoint-worker\.ts/)?.[0];
    const entrypoint = fs.readFileSync('src/infrastructure/inbound/entrypoint-worker.ts', 'utf8');
    const imported = entrypoint.match(/import\(['"]\.\/(\S+\.ts)['"]\)/)?.[1];
    assert.equal(
      fromCompose !== undefined,
      true,
      'compose worker: expected command running entrypoint-worker.ts (Node entrypoint, no shell)',
    );
    assert.equal(
      imported,
      'worker.ts',
      `entrypoint-worker.ts: expected it to import ./worker.ts (the polling loop), got ${String(imported)}`,
    );
    assert.equal(
      fromScript,
      'src/infrastructure/inbound/worker.ts',
      `package.json start:worker: expected node src/infrastructure/inbound/worker.ts, got ${String(fromScript)}`,
    );
    assert.equal(
      fs.existsSync('image/entrypoint-worker.sh'),
      false,
      'image/entrypoint-worker.sh: must be deleted (Node entrypoint only; no shell in the boot path)',
    );
  });

  it('compose worker service is runtime-hardened (least-privilege execution)', () => {
    const compose = fs.readFileSync('compose.yaml', 'utf8');
    const workerBlock = compose.slice(compose.indexOf('  worker:'), compose.indexOf('  vpn:'));
    assert.equal(
      workerBlock.includes('cap_drop:'),
      true,
      'compose worker: expected cap_drop (drop ALL capabilities; worker binds no port and needs no NET_ADMIN)',
    );
    assert.equal(
      /cap_drop:\s*\n\s*-\s*"?ALL"?/.test(workerBlock),
      true,
      'compose worker: expected cap_drop: [ALL] (worker only forks yt-dlp/ffmpeg, no capability required)',
    );
    assert.equal(
      workerBlock.includes('no-new-privileges:true'),
      true,
      'compose worker: expected security_opt no-new-privileges (setuid binaries from parsed media must not gain privilege)',
    );
    assert.equal(
      /read_only:\s*true/.test(workerBlock),
      true,
      'compose worker: expected read_only: true (image filesystem immutable; only volumes + tmpfs are writable)',
    );
    assert.equal(
      workerBlock.includes('pids_limit:'),
      true,
      'compose worker: expected pids_limit (bound fork bombs from yt-dlp/ffmpeg subprocess trees)',
    );
    assert.equal(
      /tmpfs:[\s\S]*\/tmp:rw,noexec,nosuid,nodev/.test(workerBlock),
      true,
      'compose worker: expected tmpfs /tmp with rw,noexec,nosuid,nodev (scratch space for yt-dlp/ffmpeg without exec from tmp)',
    );
    assert.equal(
      /mem_limit:\s*"?1536m"?/.test(workerBlock),
      true,
      'compose worker: expected mem_limit 1536m (bounds ffmpeg/yt-dlp working set; see todo.md P1)',
    );
    assert.equal(
      /cpus:\s*"?2"?/.test(workerBlock),
      true,
      'compose worker: expected cpus 2 (bounded CPU for parsing untrusted media; see todo.md P1)',
    );
    assert.equal(
      workerBlock.includes('entrypoint-worker.sh'),
      false,
      'compose worker: must not run a shell entrypoint (no shell in the boot path)',
    );
    assert.equal(
      /network_mode:/.test(workerBlock),
      false,
      'compose worker: network_mode must be absent — the worker parses untrusted media on the isolated ' +
        'bridge network (todo.md P2), never host networking (LAN/host-loopback reachable). Bridge DNS + ' +
        'vpn SOCKS are gated by scripts/dns-regression.sh; do not re-add host networking without it.',
    );
    assert.equal(
      /^\s+ports:/m.test(workerBlock),
      false,
      'compose worker: must publish no port (it polls the jobs DB; on the bridge network nothing is exposed)',
    );
  });

  it('compose app service is runtime-hardened (least-privilege execution)', () => {
    const compose = fs.readFileSync('compose.yaml', 'utf8');
    const appBlock = compose.slice(compose.indexOf('  app:'), compose.indexOf('  worker:'));
    assert.equal(
      /cap_drop:\s*\n\s*-\s*"?ALL"?/.test(appBlock),
      true,
      'compose app: expected cap_drop: [ALL] (app binds an unprivileged port and opens no socket/device; no capability required)',
    );
    assert.equal(
      appBlock.includes('cap_add:'),
      false,
      'compose app: must not re-add any capability (least privilege; unlike vpn, the app needs none)',
    );
    assert.equal(
      appBlock.includes('no-new-privileges:true'),
      true,
      'compose app: expected security_opt no-new-privileges (defense in depth; distroless ships no setuid binaries)',
    );
    assert.equal(
      /read_only:\s*true/.test(appBlock),
      true,
      'compose app: expected read_only: true (image filesystem immutable; only the jobs-data volume is writable)',
    );
    assert.equal(
      /pids_limit:\s*128/.test(appBlock),
      true,
      'compose app: expected pids_limit: 128 (single Node process, no subprocess trees; headroom for Node/libuv/V8 threads while bounding fork bombs)',
    );
    assert.equal(
      /mem_limit:\s*"?256m"?/.test(appBlock),
      true,
      'compose app: expected mem_limit 256m (single Express process + SQLite; see todo.md P1)',
    );
    assert.equal(
      /cpus:\s*"?0\.5"?/.test(appBlock),
      true,
      'compose app: expected cpus 0.5 (bounded CPU; the app only serves a small JSON API; see todo.md P1)',
    );
    assert.equal(
      /tmpfs:[\s\S]*\/tmp:rw,noexec,nosuid,nodev/.test(appBlock),
      true,
      'compose app: expected tmpfs /tmp with rw,noexec,nosuid,nodev (holds SQLite temp files without exec from tmp)',
    );
    assert.equal(
      appBlock.includes('"127.0.0.1:8080:8080"'),
      true,
      'compose app: expected loopback-only port publish 127.0.0.1:8080:8080 (never publish on all interfaces)',
    );
    assert.equal(
      appBlock.includes('HOST: "0.0.0.0"'),
      true,
      'compose app: expected HOST=0.0.0.0 inside the container (it must receive the forwarded traffic on its interface; the loopback-only publish above is what keeps the host side on loopback)',
    );
  });

  it('e2e compose app service is runtime-hardened (mirrors compose.yaml)', () => {
    const e2e = fs.readFileSync('e2e/compose.e2e.yaml', 'utf8');
    const appBlock = e2e.slice(e2e.indexOf('  app:'), e2e.indexOf('  # Fake worker'));
    assert.equal(
      appBlock.includes('HOST: "0.0.0.0"'),
      true,
      'e2e compose app: expected HOST=0.0.0.0 inside the container (mirrors compose.yaml app)',
    );
    assert.equal(
      /cap_drop:\s*\n\s*-\s*"?ALL"?/.test(appBlock),
      true,
      'e2e compose app: expected cap_drop: [ALL] (same hardened config as compose.yaml app, so test-containers exercises it)',
    );
    assert.equal(
      appBlock.includes('cap_add:'),
      false,
      'e2e compose app: must not re-add any capability (least privilege; the app needs none)',
    );
    assert.equal(
      appBlock.includes('no-new-privileges:true'),
      true,
      'e2e compose app: expected security_opt no-new-privileges:true (mirrors compose.yaml app)',
    );
    assert.equal(
      /read_only:\s*true/.test(appBlock),
      true,
      'e2e compose app: expected read_only: true (image filesystem immutable; only the bind-mounted data dir is writable)',
    );
    assert.equal(
      /pids_limit:\s*128/.test(appBlock),
      true,
      'e2e compose app: expected pids_limit: 128 (single Node process, same as compose.yaml app)',
    );
    assert.equal(
      /mem_limit:\s*"?256m"?/.test(appBlock),
      true,
      'e2e compose app: expected mem_limit 256m (mirrors compose.yaml app; see todo.md P1)',
    );
    assert.equal(
      /cpus:\s*"?0\.5"?/.test(appBlock),
      true,
      'e2e compose app: expected cpus 0.5 (mirrors compose.yaml app; see todo.md P1)',
    );
    assert.equal(
      /tmpfs:[\s\S]*\/tmp:rw,noexec,nosuid,nodev/.test(appBlock),
      true,
      'e2e compose app: expected tmpfs /tmp with rw,noexec,nosuid,nodev (mirrors compose.yaml app)',
    );
  });

  it('e2e compose fake worker service is runtime-hardened (mirrors compose.yaml app)', () => {
    const e2e = fs.readFileSync('e2e/compose.e2e.yaml', 'utf8');
    const workerBlock = e2e.slice(e2e.indexOf('  worker:'));
    assert.equal(
      /cap_drop:\s*\n\s*-\s*"?ALL"?/.test(workerBlock),
      true,
      'e2e compose worker: expected cap_drop: [ALL] (fake worker runs the same distroless app target; binds an unprivileged port, needs no capability)',
    );
    assert.equal(
      workerBlock.includes('cap_add:'),
      false,
      'e2e compose worker: must not re-add any capability (least privilege; the fake worker needs none)',
    );
    assert.equal(
      workerBlock.includes('no-new-privileges:true'),
      true,
      'e2e compose worker: expected security_opt no-new-privileges:true (mirrors compose.yaml app)',
    );
    assert.equal(
      /read_only:\s*true/.test(workerBlock),
      true,
      'e2e compose worker: expected read_only: true (fake worker writes only to the shared data dir)',
    );
    assert.equal(
      /pids_limit:\s*128/.test(workerBlock),
      true,
      'e2e compose worker: expected pids_limit: 128 (single Node process, same as compose.yaml app)',
    );
    assert.equal(
      /mem_limit:\s*"?256m"?/.test(workerBlock),
      true,
      'e2e compose worker: expected mem_limit 256m (fake worker runs the app target; mirrors compose.yaml app)',
    );
    assert.equal(
      /cpus:\s*"?0\.5"?/.test(workerBlock),
      true,
      'e2e compose worker: expected cpus 0.5 (fake worker runs the app target; mirrors compose.yaml app)',
    );
    assert.equal(
      /tmpfs:[\s\S]*\/tmp:rw,noexec,nosuid,nodev/.test(workerBlock),
      true,
      'e2e compose worker: expected tmpfs /tmp with rw,noexec,nosuid,nodev (mirrors compose.yaml app)',
    );
  });

  it('compose vpn service is runtime-hardened (least-privilege execution)', () => {
    const compose = fs.readFileSync('compose.yaml', 'utf8');
    const vpnBlock = compose.slice(compose.indexOf('  vpn:'), compose.indexOf('\nvolumes:'));
    assert.equal(
      /cap_drop:\s*\n\s*-\s*"?ALL"?/.test(vpnBlock),
      true,
      'compose vpn: expected cap_drop: [ALL] (only NET_ADMIN/SETUID/SETGID are re-added below; the SOCKS5 process runs unprivileged after the entrypoint drops root)',
    );
    const capAddBlock = vpnBlock.match(/cap_add:([\s\S]*?)(?=\n {4}[a-z_]+:)/)?.[1] ?? '';
    const caps = [...capAddBlock.matchAll(/-\s*"?([A-Z_]+)"?/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      caps,
      ['NET_ADMIN', 'SETGID', 'SETUID'],
      `compose vpn: expected cap_add exactly [NET_ADMIN, SETUID, SETGID] (NET_ADMIN for ip/wg, SETUID/SETGID for the root→node drop after wg-quick up; socks5 on 1080 needs no NET_BIND_SERVICE), got ${JSON.stringify(caps)}`,
    );
    assert.equal(
      vpnBlock.includes('no-new-privileges:true'),
      true,
      'compose vpn: expected security_opt no-new-privileges (after the privilege drop, setuid binaries must not regain root)',
    );
    assert.equal(
      /read_only:\s*true/.test(vpnBlock),
      true,
      'compose vpn: expected read_only: true (image filesystem immutable; only the /tmp tmpfs and the ro /mullvad volume are writable)',
    );
    assert.equal(
      /pids_limit:\s*64/.test(vpnBlock),
      true,
      'compose vpn: expected pids_limit: 64 (wg-quick forks only a handful of processes; bounds fork bombs from the bash hooks)',
    );
    assert.equal(
      /mem_limit:\s*"?128m"?/.test(vpnBlock),
      true,
      'compose vpn: expected mem_limit 128m (SOCKS5 + wg-quick only; see todo.md P1)',
    );
    assert.equal(
      /cpus:\s*"?0\.25"?/.test(vpnBlock),
      true,
      'compose vpn: expected cpus 0.25 (proxying only; see todo.md P1)',
    );
    assert.equal(
      /tmpfs:[\s\S]*\/tmp:rw,noexec,nosuid,nodev/.test(vpnBlock),
      true,
      'compose vpn: expected tmpfs /tmp with rw,noexec,nosuid,nodev (holds the 0600 wg0.conf copy, unlinked after wg-quick up, without exec from tmp)',
    );
    assert.equal(
      vpnBlock.includes('command: ["node", "/app/src/vpn/entrypoint-vpn.ts"]'),
      true,
      'compose vpn: expected command running the Node entrypoint (no shell in the boot path)',
    );
    assert.equal(
      vpnBlock.includes('entrypoint-vpn.sh'),
      false,
      'compose vpn: must not run the shell entrypoint (entrypoint-vpn.sh is deleted)',
    );
    assert.equal(
      vpnBlock.includes('"/dev/net/tun:rwm"'),
      true,
      'compose vpn: expected explicit /dev/net/tun:rwm device (only device the tunnel needs)',
    );
    assert.equal(
      vpnBlock.includes('"127.0.0.1:1080:1080"'),
      true,
      'compose vpn: expected SOCKS5 published on host loopback only (127.0.0.1:1080)',
    );
    assert.equal(
      vpnBlock.includes(':/mullvad:ro'),
      true,
      'compose vpn: expected the WireGuard config volume mounted read-only (private key never writable from the container)',
    );
  });

  it('vpn entrypoint (Node, no shell) brings the tunnel up as root then drops to node', () => {
    assert.equal(
      fs.existsSync('src/vpn/entrypoint-vpn.ts'),
      true,
      'src/vpn/entrypoint-vpn.ts: must exist (Node entrypoint, like entrypoint-worker.ts)',
    );
    assert.equal(
      fs.existsSync('image/entrypoint-vpn.sh'),
      false,
      'image/entrypoint-vpn.sh: must be deleted (no shell in the boot path; bash remains only because wg-quick is a bash script)',
    );
    const entrypoint = fs.readFileSync('src/vpn/entrypoint-vpn.ts', 'utf8');
    assert.equal(
      entrypoint.includes('wg-quick'),
      true,
      'entrypoint-vpn.ts: expected wg-quick bring-up (the tunnel, PostUp hooks and all)',
    );
    assert.equal(
      entrypoint.includes('timeout'),
      true,
      'entrypoint-vpn.ts: expected a bounded wg-quick timeout (nothing may wait without limit)',
    );
    assert.equal(
      /process\.setuid\(uid\)/.test(entrypoint) && entrypoint.includes('/etc/passwd'),
      true,
      "entrypoint-vpn.ts: expected a privilege drop to the node user after wg-quick up (process.setuid(uid)), resolved via /etc/passwd (os.userInfo('node') returns the current user in this Node, so it would drop to uid 0 — i.e. not drop at all)",
    );
    assert.equal(
      /rmSync|unlink/.test(entrypoint),
      true,
      'entrypoint-vpn.ts: expected the /tmp/wg0.conf copy (private key) to be unlinked after wg-quick up (shortest exposure window)',
    );
    assert.equal(
      entrypoint.includes("import('./socks5.ts')"),
      true,
      'entrypoint-vpn.ts: expected it to start ./socks5.ts only after the privilege drop (dynamic import after setuid)',
    );
  });

  it('Dockerfile vpn stage ships only wg-quick and the SOCKS5 runtime', () => {
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
    const vpn = stages.get('vpn') ?? '';
    assert.equal(
      /^FROM\s+node:26\.13\.1-trixie-slim@sha256:\S+\s+AS\s+vpn/m.test(vpn),
      true,
      'vpn stage: expected its own pinned slim FROM (not FROM base, otherwise it inherits the whole app/worker tree, pnpm and node_modules)',
    );
    assert.equal(
      vpn.includes('bash='),
      true,
      'vpn stage: expected bash for wg-quick (a bash script) and the PostUp hooks',
    );
    assert.equal(vpn.includes('wireguard-tools='), true, 'vpn stage: expected wireguard-tools for wg-quick');
    assert.equal(
      vpn.includes('iproute2='),
      true,
      'vpn stage: expected iproute2 for wg-quick ip calls and the PostUp hook',
    );
    assert.equal(
      vpn.includes('COPY src/vpn/'),
      true,
      'vpn stage: expected COPY of src/vpn only (the SOCKS5 server + Node entrypoint, Node built-ins only, no dependency)',
    );
    assert.equal(
      vpn.includes('COPY --from=base'),
      false,
      'vpn stage: must not copy /app from base (that ships domain/application/infrastructure, the OpenRouter secret store and express)',
    );
    assert.equal(
      vpn.includes('pnpm'),
      false,
      'vpn stage: must not install or ship pnpm (no dependency to install at runtime)',
    );
    assert.equal(
      vpn.includes('/usr/local/lib/node_modules/npm'),
      true,
      'vpn stage: expected npm purged from the node image (runtime only needs the node binary)',
    );
    assert.equal(
      vpn.includes('entrypoint-vpn.sh'),
      false,
      'vpn stage: must not ship the shell entrypoint (Node entrypoint only)',
    );
    for (const pkg of ['ffmpeg=', 'python3=', 'gnupg=', 'curl=']) {
      assert.equal(vpn.includes(pkg), false, `vpn stage: must not install ${pkg} (SOCKS5 + wg-quick only)`);
    }
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
    assert.equal(
      worker.includes('gnupg='),
      false,
      'worker stage: must not install gnupg (legacy GPG secret fallback removed; host syncs the podman secret)',
    );
    assert.equal(
      worker.includes('bash='),
      false,
      'worker stage: must not install bash (Node entrypoint only; base carries bash for vpn)',
    );
    assert.equal(
      /FROM\s+\S+\s+AS\s+worker/.test(worker),
      true,
      'worker stage: expected its own FROM line (not FROM base, otherwise it inherits bash + apt tooling from base)',
    );
    assert.equal(
      worker.includes('apt-get purge'),
      true,
      'worker stage: expected apt-get purge of pipx after installing yt-dlp (pipx is build-only, must not ship at runtime)',
    );
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
