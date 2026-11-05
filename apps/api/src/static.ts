// Same-origin hosting of the built operator web app (apps/web/dist). Read-only files from one directory: resolved
// paths must stay inside it (no traversal, no symlink escape), only known content types are served, and every other
// non-API GET falls back to index.html for client-side routes. The CSP and security headers from app.ts apply to
// every response; hashed assets are cacheable, the HTML shell is not.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SPA_ROUTE = /^(?:|incidents(?:\/[A-Za-z0-9_/-]{0,200})?|ledger|policies|notifications|auth\/callback)$/;

export async function registerStatic(app: FastifyInstance, webRoot: string): Promise<void> {
  const root = await realpath(webRoot);
  const index = await readFile(join(root, 'index.html'));

  async function resolveFile(urlPath: string): Promise<{ bytes: Buffer; type: string } | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const type = TYPES[extname(decoded).toLowerCase()];
    if (!type) return null;
    let real: string;
    try {
      real = await realpath(join(root, decoded));
    } catch {
      return null;
    }
    if (real !== root && !real.startsWith(root + sep)) return null;
    const s = await stat(real);
    if (!s.isFile() || s.size > 8 * 1024 * 1024) return null;
    return { bytes: await readFile(real), type };
  }

  app.get('/*', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '/').replace(/^\/+/, '');
    if (path.startsWith('v1/') || path.startsWith('health/')) return reply.callNotFound();
    const file = path === '' ? null : await resolveFile(path);
    if (file) {
      void reply.header(
        'cache-control',
        path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return reply.type(file.type).send(file.bytes);
    }
    // The shell is served only for the console's own client routes; anything else is a plain 404.
    if (extname(path) !== '' || !SPA_ROUTE.test(path)) return reply.callNotFound();
    // The OIDC popup callback must not carry a COOP that would sever its opener after the cross-origin round trip.
    if (path === 'auth/callback') reply.removeHeader('cross-origin-opener-policy');
    void reply.header('cache-control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(index);
  });
}
