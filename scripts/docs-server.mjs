#!/usr/bin/env node
// Tiny dependency-free static server for the docs site (node:http).
// Binds 127.0.0.1 by default — exposure happens via `tailscale serve` (see
// .mise/tasks/docs.sh --expose), never on the public interface.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname ?? process.cwd(), '..', 'docs');
const PORT = Number(process.env.DOCS_PORT || 8123);
const HOST = process.env.DOCS_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = urlPath === '/' ? '/index.html' : urlPath;
    file = normalize(file).replace(/^\.\./, '');           // no traversal
    const abs = join(ROOT, file);
    if (!abs.startsWith(ROOT)) throw http(403, 'Forbidden');

    const info = await stat(abs).catch(() => null);
    if (info?.isDirectory()) {
      const redirect = new URL(req.url, 'http://x');
      if (!redirect.pathname.endsWith('/')) { res.writeHead(301, { Location: redirect.pathname + '/' }); return res.end(); }
      file = join(file, 'index.html');
    }
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    const status = error?.status || 500;
    if (status === 404) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found.'); }
    console.error(error);
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(error?.message || 'Server error.');
  }
});

function http(status, message) { const e = new Error(message); e.status = status; return e; }

server.listen(PORT, HOST, () => {
  console.log(`Docs: http://${HOST}:${PORT}/  (root ${ROOT})`);
  console.log(`Expose on the tailnet: sudo tailscale serve --bg --https=8443 http://${HOST}:${PORT}`);
});
