// Worker operations listener (M14; NFR-09). A plain node:http server meant for a loopback or private-network address
// only (never published): unauthenticated liveness and readiness for the orchestrator's probes, and Prometheus metrics
// plus per-runner status only for a bearer holding the operations token (file-delivered, compared in constant time).
// Readiness: the database is critical; a stopping scheduler is unavailable; a runner failing repeatedly or overdue is
// degraded (visible, never hidden as healthy). Responses carry no error text.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { HealthRegistry, MetricsRegistry } from '@uptimebuyer/observability';
import type { Scheduler } from './scheduler.js';

export function registerSchedulerChecks(health: HealthRegistry, scheduler: Scheduler, startedAt = Date.now()): void {
  health.register(
    'scheduler',
    async () => (scheduler.isStopping ? { status: 'fail', detail: 'STOPPING' } : { status: 'pass' }),
    { critical: true },
  );
  health.register(
    'runners',
    async () => {
      const now = Date.now();
      const bad = scheduler.status().filter((r) => {
        if (r.consecutiveFailures >= 3) return true;
        const last = r.lastSuccessAt ? Date.parse(r.lastSuccessAt) : startedAt;
        return now - last > r.intervalMs * 3 + 60_000;
      });
      return bad.length === 0 ? { status: 'pass' } : { status: 'warn', detail: `RUNNERS_DEGRADED ${bad.length}` };
    },
    { critical: false },
  );
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export function buildWorkerOpsServer(opts: {
  health: HealthRegistry;
  metrics: MetricsRegistry;
  scheduler: Scheduler;
  token: string | null;
  beforeScrape?: () => Promise<void>;
}): http.Server {
  if (opts.token !== null && opts.token.length < 32) throw new Error('operations token must be >= 32 chars');
  const expected = opts.token === null ? null : digest(`Bearer ${opts.token}`);
  const authorized = (req: http.IncomingMessage) => {
    const h = req.headers.authorization;
    return expected !== null && typeof h === 'string' && timingSafeEqual(digest(h), expected);
  };
  const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      if (path === '/health/live') return send(res, 200, opts.health.live());
      if (path === '/health/ready') {
        const r = await opts.health.ready();
        return send(res, r.status === 'unavailable' ? 503 : 200, r);
      }
      if (!authorized(req))
        return send(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication failed.' } });
      if (path === '/metrics') {
        await opts.beforeScrape?.().catch(() => {});
        return send(res, 200, opts.metrics.exposition(), 'text/plain; version=0.0.4');
      }
      if (path === '/status') return send(res, 200, { runners: opts.scheduler.status() });
      return send(res, 404, { error: { code: 'NOT_FOUND' } });
    })().catch(() => send(res, 500, { error: { code: 'INTERNAL' } }));
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  return server;
}
