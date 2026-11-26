// Entrypoint VPN (Node, no shell) — replaces image/entrypoint-vpn.sh.
//
// Compose runs this file directly with `node` as root (the container user
// stays root because wg-quick needs it), so the boot path has no shell.
// bash still ships in the image, but only because wg-quick itself is a bash
// script (it also evals the Mullvad PostUp/PreDown hooks) — the entrypoint
// never invokes a shell itself.
//
// Sequence:
//   1. No config (fresh clone): warn, drop to `node`, stay alive (so
//      restart: unless-stopped does not loop; cf. compose.yaml).
//   2. Config present: copy it to /tmp (0600), `wg-quick up` as root with a
//      bounded timeout, unlink the copy (private-key exposure window ends
//      as soon as the kernel interface is configured), drop to `node`, then
//      start the SOCKS5 server — which therefore never runs as root.
//      Port 1080 > 1024 needs no CAP_NET_BIND_SERVICE, so the dropped
//      process needs no capability at all (cap_drop: [ALL] in compose,
//      no-new-privileges prevents regaining any on exec).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const CONF_SRC = '/mullvad/wg0.conf';
const CONF_TMP = '/tmp/wg0.conf';
// wg-quick up is local netlink work; 30s is a generous bound (nothing may
// wait without limit).
const WG_QUICK_TIMEOUT_MS = 30_000;

function dropToNode(): void {
  // os.userInfo('node') is unreliable here: it returns the *current* user
  // (root) instead of the named one, which would drop to uid 0 — i.e. not
  // drop at all. Resolve the node account from /etc/passwd instead
  // (uid/gid 1000 in the node:* images, see the worker stage).
  const line = fs
    .readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('node:'));
  const uid = Number(line?.split(':')[2]);
  const gid = Number(line?.split(':')[3]);
  if (line === undefined || !Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error('entrypoint-vpn: node user not found in /etc/passwd');
  }
  // @types/node marks these optional (absent on non-root platforms); fail
  // loud rather than silently staying root if they are missing.
  if (
    typeof process.setgroups !== 'function' ||
    typeof process.setgid !== 'function' ||
    typeof process.setuid !== 'function'
  ) {
    throw new Error('entrypoint-vpn: setuid/setgid unavailable, cannot drop privileges');
  }
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
}

function stayAlive(): void {
  // Sleep infinity as the unprivileged user (the old shell entrypoint
  // exec'd `sleep infinity` as root). SIGTERM/SIGINT exit cleanly.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  setInterval(() => {}, 60_000);
}

if (!fs.existsSync(CONF_SRC)) {
  console.error("Mullvad non configuré — lance 'mise run mullvad init' (README §Mullvad VPN).");
  console.error('Le service vpn reste en attente; pour télécharger en direct: MULLVAD_ENABLED=false dans .env');
  dropToNode();
  stayAlive();
} else {
  fs.copyFileSync(CONF_SRC, CONF_TMP);
  fs.chmodSync(CONF_TMP, 0o600);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('wg-quick', ['up', CONF_TMP], {
      stdio: 'inherit',
      timeout: WG_QUICK_TIMEOUT_MS,
    });
  } finally {
    // The interface already lives in the kernel; the copy (private key)
    // must not linger on disk for the container's lifetime.
    fs.rmSync(CONF_TMP, { force: true });
  }
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error !== undefined ? String(result.error) : `exit ${String(result.status)}`;
    console.error(`wg-quick up a échoué (${detail}) — le conteneur va redémarrer.`);
    process.exit(1);
  }
  dropToNode();
  await import('./socks5.ts');
}
