// Operations listener (M13; NFR-09, OBSERVABILITY-OPERATIONS §3/§7). A separate Fastify instance meant for a loopback
// or private-network address only, never the public API port: Prometheus metrics and currently firing alerts are
// served only to a bearer holding the operations token (delivered through the secret channel, compared in constant
// time); liveness and readiness stay unauthenticated for orchestrator probes and expose no error text. Metrics carry
// no tenant, site, incident or provider-reference labels by construction (closed label sets).
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ALERT_RULES,
  evaluateAlerts,
  type AlertRule,
  type HealthRegistry,
  type MetricsRegistry,
} from '@uptimebuyer/observability';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

export interface OperationsServerOptions {
  metrics: MetricsRegistry;
  health: HealthRegistry;
  /** At least 32 characters of secret material. */
  token: string;
  alertRules?: readonly AlertRule[];
  /** Refresh database-derived gauges before a scrape (packages/operations collectPlatformSignals). */
  beforeScrape?: () => Promise<void>;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export async function buildOperationsServer(opts: OperationsServerOptions): Promise<FastifyInstance> {
  if (typeof opts.token !== 'string' || opts.token.length < 32) throw new Error('operations token must be >= 32 chars');
  const expected = digest(`Bearer ${opts.token}`);
  const authorized = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return typeof h === 'string' && timingSafeEqual(digest(h), expected);
  };
  const app = Fastify({ logger: false, bodyLimit: 1024, return503OnClosing: true });
  app.addHook('onRequest', async (req, reply) => {
    void reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/health/') && !authorized(req))
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Authentication failed.' } });
  });
  app.get('/health/live', async () => opts.health.live());
  app.get('/health/ready', async (_req, reply) => {
    const r = await opts.health.ready();
    return reply.status(r.status === 'unavailable' ? 503 : 200).send(r);
  });
  app.get('/metrics', async (_req, reply) => {
    await opts.beforeScrape?.().catch(() => {});
    return reply.type('text/plain; version=0.0.4').send(opts.metrics.exposition());
  });
  app.get('/alerts', async () => {
    await opts.beforeScrape?.().catch(() => {});
    return { firing: evaluateAlerts(opts.alertRules ?? ALERT_RULES, opts.metrics) };
  });
  await app.ready();
  return app;
}
