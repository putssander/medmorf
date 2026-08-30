// Static dev server that adds cross-origin isolation headers (COOP/COEP) so
// SharedArrayBuffer / multithreaded WASM become available.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const port = Number(process.env.PORT || 8001);
const coep = process.env.COEP || 'credentialless';
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.wav':'audio/wav', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.txt':'text/plain', '.xlsx':'application/octet-stream', '.png':'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': coep, 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('isolated server on', port, 'COEP', coep));
