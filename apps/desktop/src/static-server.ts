import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the exported console over http://127.0.0.1:<consolePort>.
 *
 * Loading it from file:// would be simpler, but a file:// page sends
 * `Origin: null`, which the bridge rightly refuses. Serving it on the same
 * origin the bridge already trusts means the packaged app and `pnpm helm`
 * behave identically, with no special case in the security rules.
 */
export function serveConsole(root: string, port: number): Promise<Server> {
  const rootPath = resolve(root);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';

    // Contain every request inside the exported bundle.
    const target = resolve(join(rootPath, normalize(rel)));
    if (target !== rootPath && !target.startsWith(rootPath + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let file = target;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const asHtml = `${target}.html`;
      file = existsSync(asHtml) ? asHtml : join(rootPath, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}
