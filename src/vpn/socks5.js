// Serveur SOCKS5 minimal (CONNECT, sans auth) qui tourne DANS le container VPN.
// Tout son trafic sort par le tunnel Mullvad (route par défaut via wg0 dans le
// netns du sidecar). Le worker pointe yt-dlp dessus: --proxy socks5h://127.0.0.1:1080
// (socks5h = le nom d'hôte est résolu PAR le proxy, donc DNS aussi via le tunnel).
const net = require('node:net');
const dns = require('node:dns');

const PORT = Number(process.env.SOCKS_PORT || 1080);
const HOST = process.env.SOCKS_HOST || '0.0.0.0';
const MULLVAD_DNS = process.env.MULLVAD_DNS || '10.64.0.1';

// Résolution DNS via le DNS Mullvad (dans le tunnel). Le resolv.conf du
// container pointe vers le stub systemd-resolved de l'hôte, injoignable ici.
// Pas de fallback vers le résolveur système: la requête DNS fuirait hors du
// tunnel (garantie de confidentialité du sidecar).
const resolver = new dns.promises.Resolver();
try { resolver.setServers([MULLVAD_DNS]); } catch {}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  const ips = await resolver.resolve4(host);
  if (!ips.length) throw new Error(`no A record for ${host}`);
  return ips[0];
}

function parseAddress(buf, offset) {
  const atyp = buf[offset];
  if (atyp === 0x01) { // IPv4
    const host = `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`;
    return { host, addrLen: 5 };
  }
  if (atyp === 0x03) { // domaine
    const len = buf[offset + 1];
    return { host: buf.slice(offset + 2, offset + 2 + len).toString('utf8'), addrLen: len + 2 };
  }
  if (atyp === 0x04) { // IPv6
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(offset + 1 + i).toString(16));
    return { host: groups.join(':'), addrLen: 17 };
  }
  return null;
}

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', (greeting) => {
    if (greeting.length < 2 || greeting[0] !== 0x05) return socket.destroy();
    socket.write(Buffer.from([0x05, 0x00])); // seule méthode acceptée: no-auth
    socket.once('data', async (request) => {
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
        let ip;
        try {
          ip = await resolveHost(addr.host); // DNS via le tunnel (10.64.0.1)
        } catch (error) {
          console.error(`CONNECT ${addr.host}:${port} — DNS via le tunnel impossible (${error.message})`);
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
        console.error(`Requête SOCKS5 malformée ignorée: ${error.message}`);
        socket.destroy();
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`socks5://${HOST}:${PORT} — trafic via tunnel Mullvad`);
});
