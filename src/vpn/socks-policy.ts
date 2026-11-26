/**
 * Politique du sidecar SOCKS5 Mullvad (défense en profondeur).
 *
 * Le confinement principal reste le tunnel WireGuard (wg0.conf, hors repo) :
 * tout le trafic sort par le tunnel. Ce module ajoute un deny explicite des
 * destinations non-routables — loopback, link-local, privé, métadonnées
 * cloud, CGNAT, multicast, réservé — pour que même une requête SOCKS5
 * malveillante ou trompée ne puisse pas joindre les services du netns,
 * le réseau du bridge, ou la passerelle link-local (cf. todo.md).
 *
 * Pur, sans I/O : Node built-ins uniquement (le stage image `vpn` ne copie
 * que `src/vpn/`, sans dépendance).
 */
import net from 'node:net';

/** Parse une IPv4 stricte en entier 32 bits, ou null si invalide. */
function parseIPv4(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (
    (((parts[0] as number) << 24) |
      ((parts[1] as number) << 16) |
      ((parts[2] as number) << 8) |
      (parts[3] as number)) >>>
    0
  );
}

// CIDR IPv4 bloqués [base, préfixe], convertis en entiers une seule fois.
const BLOCKED_IPV4: Array<[number, number]> = (
  [
    ['0.0.0.0', 8], // "cette machine" (dont 0.0.0.0)
    ['10.0.0.0', 8], // privé
    ['100.64.0.0', 10], // CGNAT (range Tailscale inclus)
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local (dont 169.254.169.254, métadonnées cloud)
    ['172.16.0.0', 12], // privé (172.16.0.0 – 172.31.255.255)
    ['192.0.0.0', 24], // affectations IETF (dont NAT64 local)
    ['192.0.2.0', 24], // TEST-NET-1 (documentation)
    ['192.168.0.0', 16], // privé
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2 (documentation)
    ['203.0.113.0', 24], // TEST-NET-3 (documentation)
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // réservé (dont 255.255.255.255)
  ] as Array<[string, number]>
).map(([base, prefix]) => [parseIPv4(base) as number, prefix] as [number, number]);

/** Vrai si l'entier IPv4 tombe dans un des CIDR bloqués. */
function isBlockedIPv4Num(value: number): boolean {
  return BLOCKED_IPV4.some(([baseNum, prefix]) => {
    const shift = 32 - prefix;
    return value >>> shift === baseNum >>> shift;
  });
}

/**
 * Étend une IPv6 en 8 groupes de 16 bits, ou null si invalide.
 * Gère `::` et une IPv4 embarquée en fin d'adresse (::ffff:1.2.3.4).
 * L'appelant a déjà validé avec net.isIPv6 : les gardes ici sont défensives.
 */
function expandIPv6(raw: string): number[] | null {
  let ip = raw;
  const pct = ip.indexOf('%');
  if (pct !== -1) ip = ip.slice(0, pct); // zone-id (fe80::1%eth0)
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = parseIPv4(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === '') return [];
    const groups = half.split(':').map((g) => Number.parseInt(g, 16));
    if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
    return groups;
  };
  if (halves.length === 2) {
    const left = parseHalf(halves[0] as string);
    const right = parseHalf(halves[1] as string);
    if (left === null || right === null) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...Array.from({ length: missing }, () => 0), ...right];
  }
  const all = parseHalf(ip);
  if (all === null || all.length !== 8) return null;
  return all;
}

function isBlockedIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (g === null) return true;
  const [g0, g1, g2, g3] = g as [number, number, number, number, number, number, number, number];
  // IPv4-mappée ::ffff:a.b.c.d : on juge sur l'IPv4 embarquée.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIPv4Num(((g[6] as number) << 16) | (g[7] as number));
  }
  // Seul l'unicast global 2000::/3 est autorisé a priori : tout le reste
  // (::, ::1, ::/96, NAT64 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10,
  // fec0::/10, ff00::/8, plage non allouée) est bloqué d'office.
  if ((g0 & 0xe000) !== 0x2000) return true;
  // Mécanismes de transition et plages spéciales DANS 2000::/3 : jamais
  // nécessaires pour joindre YouTube, et capables d'encapsuler une IPv4
  // privée (6to4 2002::/16, Teredo 2001::/32).
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0002 || g1 === 0xdb8)) return true; // Teredo, benchmarking, documentation
  return false;
}

/**
 * Vrai si l'une des adresses résolues pour un hostname est bloquée.
 * Un hostname ne doit pas mélanger public et privé : on refuse dès qu'un
 * seul enregistrement A est non-routable (défense en profondeur, même si
 * seul le premier est dialé ensuite).
 */
export function hasBlockedAddress(ips: string[]): boolean {
  return ips.some((candidate) => isBlockedIp(candidate));
}

/** Bornes du serveur SOCKS5 : rien ne peut attendre ou croître sans limite. */
export interface SocksLimits {
  /** Cap de connexions simultanées (au-delà, la connexion est refusée). */
  maxConnections: number;
  /** Délai max pour établir la connexion amont. */
  connectTimeoutMs: number;
  /** Délai max d'inactivité (client et amont) avant coupure. */
  idleTimeoutMs: number;
  /** Délai max pour la résolution DNS via Mullvad. */
  dnsTimeoutMs: number;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Lit les bornes depuis l'environnement, bornées et avec défauts sûrs. */
export function parseSocksLimits(env: Record<string, string | undefined>): SocksLimits {
  return {
    maxConnections: boundedInt(env.SOCKS_MAX_CONNECTIONS, 32, 1, 256),
    connectTimeoutMs: boundedInt(env.SOCKS_CONNECT_TIMEOUT_MS, 10_000, 100, 60_000),
    idleTimeoutMs: boundedInt(env.SOCKS_IDLE_TIMEOUT_MS, 60_000, 1_000, 600_000),
    dnsTimeoutMs: boundedInt(env.SOCKS_DNS_TIMEOUT_MS, 5_000, 100, 30_000),
  };
}

/**
 * Vrai si l'IP littérale ne doit jamais être jointe via CONNECT.
 * Fail-closed : une entrée qui n'est pas une IP valide est bloquée.
 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = parseIPv4(ip);
    return value === null || isBlockedIPv4Num(value);
  }
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  // Une IPv6 à zone-id (fe80::1%eth0) n'est pas reconnue par isIPv6 sur
  // toutes les plateformes : on tente l'expansion avant de conclure.
  if (ip.includes(':') && expandIPv6(ip) !== null) return isBlockedIPv6(ip);
  return true;
}
