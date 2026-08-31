// Serveur SOCKS5 minimal (CONNECT, sans auth) qui tourne DANS le container VPN.
// Tout son trafic sort par le tunnel Mullvad (route par défaut via wg0 dans le
// netns du sidecar). Le worker pointe yt-dlp dessus: --proxy socks5h://127.0.0.1:1080
// (socks5h = le nom d'hôte est résolu PAR le proxy, donc DNS aussi via le tunnel).

import dns from 'node:dns';
import net from 'node:net';

const PORT = Number(process.env.SOCKS_PORT || 1080);
// Défaut loopback — en production le sidecar `vpn` surcharge via
// SOCKS_HOST=0.0.0.0 (confiné à son netns, publié host 127.0.0.1:1080 uniquement).
const HOST = process.env.SOCKS_HOST || '127.0.0.1';
const MULLVAD_DNS = process.env.MULLVAD_DNS || '10.64.0.1';

// Résolution DNS via le DNS Mullvad (dans le tunnel). Le resolv.conf du
// container pointe vers le stub systemd-resolved de l'hôte, injoignable ici.
// Pas de fallback vers le résolveur système: la requête DNS fuirait hors du
// tunnel (garantie de confidentialité du sidecar).
const resolver = new dns.promises.Resolver();
try {
  resolver.setServers([MULLVAD_DNS]);
} catch {}

async function resolveHost(host: string): Promise<string> {
  if (net.isIP(host)) return host;
  const ips = await resolver.resolve4(host);
  const first = ips[0];
  if (!first) throw new Error(`no A record for ${host}`);
  return first;
}

interface SocksAddress {
  host: string;
  addrLen: number;
}

function parseAddress(buf: Buffer, offset: number): SocksAddress | null {
  const atyp = buf[offset];
  if (atyp === 0x01) {
    // IPv4
    const host = `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`;
    return { host, addrLen: 5 };
  }
  if (atyp === 0x03) {
    // domaine
    const len = buf[offset + 1] ?? 0;
    return { host: buf.subarray(offset + 2, offset + 2 + len).toString('utf8'), addrLen: len + 2 };
  }
  if (atyp === 0x04) {
    // IPv6
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(offset + 1 + i).toString(16));
    return { host: groups.join(':'), addrLen: 17 };
  }
  return null;
}

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', (greeting: Buffer) => {
    if (greeting.length < 2 || greeting[0] !== 0x05) return socket.destroy();
    socket.write(Buffer.from([0x05, 0x00])); // seule méthode acceptée: no-auth
    socket.once('data', async (request: Buffer) => {
      try {
        if (request.length < 7 || request[0] !== 0x05 || request[1] !== 0x01) {
          return socket.destroy(); // on ne fait que CONNECT
        }
        const addr = parseAddress(request, 3);
        if (!addr) return socket.destroy();
        // La longueur de domaine annoncée n'est pas fiable: vérifier que le
        // port (2 octets après l'adresse) est bien dans le buffer avant de
        // le lire, sinon readUInt16BE lève un RangeError qui tuerait le
        // process (rejet non géré dans ce listener async).
        if (request.length < 3 + addr.addrLen + 2) return socket.destroy();
        const port = request.readUInt16BE(3 + addr.addrLen);
        let ip: string;
        try {
          ip = await resolveHost(addr.host); // DNS via le tunnel (10.64.0.1)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`CONNECT ${addr.host}:${port} — DNS via le tunnel impossible (${message})`);
          return socket.destroy();
        }
        const remote = net.connect({ port, host: ip }, () => {
          console.log(`CONNECT ${addr.host} (${ip}):${port}`);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success
          socket.pipe(remote);
          remote.pipe(socket);
        });
        remote.on('error', () => socket.destroy());
      } catch (error) {
        // Défense en profondeur: une requête malformée coupe la connexion,
        // jamais le process du sidecar.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Requête SOCKS5 malformée ignorée: ${message}`);
        socket.destroy();
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`socks5://${HOST}:${PORT} — trafic via tunnel Mullvad`);
});

// PID 1 dans un container n'a pas de handler SIGTERM par défaut (le kernel
// l'ignore). Sans ce handler le sidecar met 10s à mourir et podman finit par
// SIGKILL, ce qui laisse un Warning bruit + race netavark setns au down.
function shutdown(signal: string): void {
  console.log(`${signal}: vpn shutting down`);
  server.close(() => process.exit(0));
  // Si des connexions restent ouvertes, force l'exit rapidement (pas de fuite
  // de tunnel : le netns meurt avec le container).
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
