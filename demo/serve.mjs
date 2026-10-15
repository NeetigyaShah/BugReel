import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // The demo app has no real backend — every /api/* call dies with a canned
  // 500, which is exactly what the Silent Failure fixture needs.
  if (url.pathname.startsWith('/api/')) {
    json(res, 500, {
      error: 'Internal Server Error',
      message: `No route handled ${req.method ?? 'GET'} ${url.pathname}`,
    });
    return;
  }

  const rel =
    url.pathname === '/' || url.pathname === '/demo' || url.pathname === '/demo/'
      ? 'demo/index.html'
      : url.pathname.slice(1);
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(4173, () => console.log('demo → http://localhost:4173/demo/'));
