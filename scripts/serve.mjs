/* Статичний сервер для локальної перевірки. Service worker і
   геолокація вимагають безпечного контексту, тому localhost —
   обов'язково: з file:// вони не працюють.

   Запуск: node scripts/serve.mjs [порт] */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'www');
const port = Number(process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    /* Не даємо вийти за межі www/ */
    const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const st = await stat(file);
    const body = await readFile(st.isDirectory() ? join(file, 'index.html') : file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      /* Service worker має право керувати всім скоупом */
      'Service-Worker-Allowed': '/'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(port, () => console.log('http://localhost:' + port));
