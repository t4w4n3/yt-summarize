#!/usr/bin/env node
// Génère une paire de clés WireGuard (X25519) — ou dérive la clé publique
// d'une clé privée existante. Équivalent de `wg genkey` / `wg pubkey`, sans
// wireguard-tools (utilisable pendant `mise run setup`, avant le build de
// l'image). Sortie: une ligne privée puis une ligne publique.
const { generateKeyPairSync, createPrivateKey, createPublicKey } = require('node:crypto');
const fs = require('node:fs');

// En-têtes DER (PKCS#8 privée / SPKI publique) pour X25519.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

if (process.argv[2] === 'pubkey') {
  // Dérive la clé publique d'une clé privée (base64, lue sur stdin).
  const raw = Buffer.from(fs.readFileSync(0, 'utf8').trim(), 'base64');
  if (raw.length !== 32) { console.error('Clé privée invalide (32 octets attendus)'); process.exit(1); }
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  process.stdout.write(pub.toString('base64') + '\n');
} else {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  process.stdout.write(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64') + '\n');
  process.stdout.write(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') + '\n');
}
