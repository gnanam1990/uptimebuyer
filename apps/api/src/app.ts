// Operator HTTP API (M12; REPOSITORY-PLAN apps/api; API-EVENT-SPEC §1-2, §7-9). A Fastify server whose routes are thin
// adapters over the module packages: each route parses its input strictly with the shared @uptimebuyer/contracts API
// schemas, derives the TenantContext from the verified bearer token (auth.ts) and calls the existing package
// function, which authorizes against the resource's own site inside its tenant transaction. It never imports the
// Kite broker (INV-06): authority sessions are requested through an injected port. Every response carries an
// X-Correlation-ID and strict security headers; errors are the stable ApiErrorBody with a safe message.
import { DomainError, newId, toApiErrorBody, type CorrelationId } from '@uptimebuyer/contracts';
import { CORRELATION_HEADER, type PublicConfig } from '@uptimebuyer/contracts/api';
import type { AuthoritySigner } from '@uptimebuyer/commerce';
import type { CredentialResolver, Db, HumanSessionVerifier, TenantContext } from '@uptimebuyer/data';
import type { ObjectStorePort } from '@uptimebuyer/evidence';
import {
  HealthRegistry,
  platformMetrics,
  type MetricsRegistry,
  type PlatformMetrics,
  type SloTracker,
  type Span,
  type StructuredLogger,
  type Tracer,
} from '@uptimebuyer/observability';
import { Bulkhead } from '@uptimebuyer/resilience';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { PreAuthGate, authenticate } from './auth.js';
import { serialize } from './http.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerFleetRoutes } from './routes/fleet.js';
import { registerIncidentRoutes } from './routes/incidents.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { contentSecurityPolicy, securityHeaders, TokenBuckets, type BucketConfig } from './security.js';
import { registerStatic } from './static.js';

/** Requests a Kite session for a freshly issued authority through the broker port (never the broker itself). */
export interface SessionActivator {
  activate(input: { tenantId: string; executionAuthorityId: string }): Promise<void>;
}

export interface ApiLimits {
  bodyLimitBytes: number;
  webhookBodyLimitBytes: number;
  authFailures: BucketConfig;
  /** Authority-bearing commands (approve, hold, issue/revoke authority, publish policy) per principal. */
  sensitiveCommands: BucketConfig;
  webhookFailures: BucketConfig;
  /** M13 bulkhead over /v1 work (public config and health are never shed): concurrent, queued, queue wait. */
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  queueTimeoutMs: number;
  /** M13 S11: concurrent token verifications per source and in total (pre-authentication work). */
  maxConcurrentAuthPerSource: number;
  maxConcurrentAuth: number;
}

export const DEFAULT_API_LIMITS: ApiLimits = Object.freeze({
  bodyLimitBytes: 64 * 1024,
  webhookBodyLimitBytes: 64 * 1024,
  authFailures: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  sensitiveCommands: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  webhookFailures: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  maxConcurrentRequests: 64,
  maxQueuedRequests: 256,
  queueTimeoutMs: 10_000,
  maxConcurrentAuthPerSource: 8,
  maxConcurrentAuth: 64,
});

/** M13 observability wiring (NFR-08, NFR-09). Every member is optional; absent members are no-ops. */
export interface ApiObservability {
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  tracer?: Tracer;
  slo?: SloTracker;
  /** Readiness checks; by default the database (critical) and, when an SLO tracker is given, SLO state. */
  health?: HealthRegistry;
}

export interface ApiServerOptions {
  pool: Db;
  verifier: HumanSessionVerifier;
  publicConfig: PublicConfig;
  store: ObjectStorePort;
  /** Resolves provider webhook verifier references (M10 fulfillment webhooks). */
  credentials: CredentialResolver;
  /** The authority-issuing workload's Ed25519 signer and the broker session port; absent = issuance unavailable. */
  authority?: { signer: AuthoritySigner; sessions: SessionActivator | null };
  /** Serve the built operator web app (apps/web/dist) from the same origin. */
  webRoot?: string;
  limits?: Partial<ApiLimits>;
  trustProxy?: boolean | string | string[];
  logger?: boolean;
  /** Clock for the token buckets (tests). */
  now?: () => number;
  observability?: ApiObservability;
}

export interface RouteDeps extends ApiServerOptions {
  limits: ApiLimits;
  sensitive: TokenBuckets;
  webhookFailures: TokenBuckets;
}

declare module 'fastify' {
  interface FastifyRequest {
    ubCorrelationId: CorrelationId;
    ubCtx: TenantContext | null;
    ubSpan: Span | null;
    ubStartedAt: number;
    ubRelease: (() => void) | null;
  }
}

/** The route's server-derived context; a route that is reached without one is a programming error. */
export function ctxOf(req: FastifyRequest): TenantContext {
  if (!req.ubCtx) throw new DomainError('UNAUTHENTICATED', 'Authentication failed.');
  return req.ubCtx;
}

/** Spend one authority-bearing command token for the authenticated principal. */
export function spendSensitive(deps: RouteDeps, req: FastifyRequest): void {
  const ctx = ctxOf(req);
  if (!deps.sensitive.take(`${ctx.tenantId}/${ctx.principal.id}`))
    throw new DomainError('RATE_LIMITED', 'Too many authority commands; retry later.', {
      reasonCode: 'COMMAND_RATE_EXCEEDED',
      retryAfterMs: deps.sensitive.retryAfterSeconds() * 1000,
    });
}

const PUBLIC_PATHS = new Set(['/v1/public-config']);

/** Bounded route classes for metrics and logs; the URL itself (it carries identifiers) is never a label. */
export function routeClassOf(
  method: string,
  path: string,
): 'read' | 'command' | 'webhook' | 'health' | 'public' | 'static' {
  if (path.startsWith('/health/')) return 'health';
  if (PUBLIC_PATHS.has(path)) return 'public';
  if (path.startsWith('/v1/fulfillment-webhooks/')) return 'webhook';
  if (path.startsWith('/v1/')) return method === 'GET' || method === 'HEAD' ? 'read' : 'command';
  return 'static';
}
const statusClass = (code: number) => (code >= 500 ? '5xx' : code >= 400 ? '4xx' : code >= 300 ? '3xx' : '2xx');

export async function buildApiServer(opts: ApiServerOptions): Promise<FastifyInstance> {
  const limits: ApiLimits = { ...DEFAULT_API_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const deps: RouteDeps = {
    ...opts,
    limits,
    sensitive: new TokenBuckets(limits.sensitiveCommands, now),
    webhookFailures: new TokenBuckets(limits.webhookFailures, now),
  };
  const failures = new TokenBuckets(limits.authFailures, now);
  const gate = new PreAuthGate({ perSource: limits.maxConcurrentAuthPerSource, global: limits.maxConcurrentAuth });
  const tokenOrigin = new URL(opts.publicConfig.oidc.tokenEndpoint).origin;
  const headers = securityHeaders(contentSecurityPolicy([tokenOrigin]));
  const obs = opts.observability ?? {};
  const pm: PlatformMetrics | null = obs.metrics ? platformMetrics(obs.metrics) : null;
  const bulkhead = new Bulkhead(
    {
      name: 'api_requests',
      maxConcurrent: limits.maxConcurrentRequests,
      maxQueued: limits.maxQueuedRequests,
      queueTimeoutMs: limits.queueTimeoutMs,
    },
    (bound) => pm?.loadShed.inc({ bound: bound as 'api_requests' }),
  );
  // M13 security review S1: unauthenticated provider callbacks get their own bulkhead, so callback pressure is shed
  // on the callback surface and can never starve authenticated operator traffic.
  const webhookBulkhead = new Bulkhead(
    {
      name: 'webhook',
      maxConcurrent: limits.maxConcurrentRequests,
      maxQueued: limits.maxQueuedRequests,
      queueTimeoutMs: limits.queueTimeoutMs,
    },
    (bound) => pm?.loadShed.inc({ bound: bound as 'webhook' }),
  );
  const health = obs.health ?? new HealthRegistry();
  if (!obs.health) {
    health.register(
      'database',
      async () => {
        await opts.pool.query('SELECT 1');
        return { status: 'pass' };
      },
      { critical: true },
    );
    if (obs.slo) health.register('slo', obs.slo.healthCheck(), { critical: false });
  }

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: limits.bodyLimitBytes,
    trustProxy: opts.trustProxy ?? false,
    return503OnClosing: true,
    // Path segments carry `{id}:{verb}` command targets. Oversized segments still reach the route, whose package
    // function refuses them as an unavailable resource (no separate length oracle); the body limit bounds the rest.
    routerOptions: { maxParamLength: 512 },
  });
  // Bodies are buffered and parsed strictly by each route (http.ts) or kept raw for signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, raw, done) => done(null, raw));
  app.setReplySerializer((payload) => serialize(payload));

  app.addHook('onRequest', async (req, reply) => {
    req.ubCorrelationId = newId('correlation');
    req.ubCtx = null;
    req.ubStartedAt = Date.now();
    req.ubRelease = null;
    req.ubSpan = null;
    if (obs.tracer) {
      const inbound = req.headers.traceparent;
      req.ubSpan = obs.tracer.startSpan('http.request', {
        parent: typeof inbound === 'string' ? inbound : null,
        correlationId: req.ubCorrelationId,
      });
      void reply.header('traceparent', req.ubSpan.traceparent());
    }
    void reply.header(CORRELATION_HEADER, req.ubCorrelationId);
    for (const [k, v] of Object.entries(headers)) void reply.header(k, v);
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/v1/')) void reply.header('cache-control', 'no-store');
    const webhook = path.startsWith('/v1/fulfillment-webhooks/');
    const operator = path.startsWith('/v1/') && !PUBLIC_PATHS.has(path) && !webhook;
    // Authenticate first (bounded by the per-source failure bucket): anonymous traffic never holds operator capacity
    // (M13 security review S7).
    if (operator)
      req.ubCtx = await authenticate(
        { pool: opts.pool, verifier: opts.verifier, failures, gate },
        req,
        req.ubCorrelationId,
      );
    // Backpressure: /v1 work beyond the bulkhead is shed explicitly (429 LOAD_SHED + Retry-After), never queued
    // without bound. Health and public configuration are never shed. The slot is tied to the response's lifetime:
    // released once on close whatever the lifecycle path, a waiter whose client left is removed from the queue, and a
    // slot granted to a request that is already gone is given back at once.
    const bh = webhook ? webhookBulkhead : operator ? bulkhead : null;
    if (bh) {
      const gone = new AbortController();
      const onClose = () => gone.abort();
      reply.raw.once('close', onClose);
      req.raw.once('close', () => {
        if (!reply.raw.writableEnded) onClose();
      });
      const release = await bh.acquire(gone.signal);
      if (gone.signal.aborted || req.raw.destroyed || reply.raw.destroyed) {
        release();
        return reply.hijack();
      }
      req.ubRelease = release;
      reply.raw.once('close', release);
    }
  });

  // A client that disconnects mid-request must not leak its bulkhead slot.
  app.addHook('onRequestAbort', async (req) => {
    req.ubRelease?.();
    req.ubRelease = null;
  });

  app.addHook('onResponse', async (req, reply) => {
    req.ubRelease?.();
    req.ubRelease = null;
    const path = req.url.split('?')[0] ?? '';
    const routeClass = routeClassOf(req.method, path);
    const status = reply.statusCode;
    const latencyMs = Date.now() - (req.ubStartedAt ?? Date.now());
    pm?.httpRequests.inc({ route_class: routeClass, status_class: statusClass(status) });
    pm?.httpDuration.observe({ route_class: routeClass }, latencyMs);
    if (obs.slo && routeClass === 'read' && status < 400) obs.slo.record('operator_read', latencyMs);
    if (obs.slo && (routeClass === 'read' || routeClass === 'command'))
      obs.slo.recordOutcome('api_availability', status < 500);
    if (req.ubSpan) {
      req.ubSpan.setAttribute('routeClass', routeClass).setAttribute('status', status);
      if (status >= 500) req.ubSpan.setStatus('ERROR', statusClass(status));
      else if (status === 422) req.ubSpan.setStatus('HELD', String(status));
      else if (status >= 400) req.ubSpan.setStatus('REJECTED', String(status));
      req.ubSpan.end();
    }
    obs.logger?.info('http.request', {
      correlationId: req.ubCorrelationId,
      traceId: req.ubSpan?.context.traceId,
      tenantId: req.ubCtx?.tenantId,
      principalKind: req.ubCtx?.principal.kind,
      method: req.method,
      route: req.routeOptions?.url ?? null,
      routeClass,
      status,
      latencyMs,
    });
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = req.ubCorrelationId ?? newId('correlation');
    const fe = err as { code?: string; statusCode?: number };
    let domain: DomainError;
    let status: number;
    if (err instanceof DomainError) {
      domain = err;
      status = err.httpStatus;
    } else if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      domain = new DomainError('VALIDATION_FAILED', 'Request body is too large.', { reasonCode: 'BODY_TOO_LARGE' });
      status = 413;
    } else if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      domain = new DomainError('VALIDATION_FAILED', 'Unsupported media type.', {
        reasonCode: 'UNSUPPORTED_MEDIA_TYPE',
      });
      status = 415;
    } else if (fe.statusCode === 404) {
      domain = new DomainError('VALIDATION_FAILED', 'No such route.', { reasonCode: 'ROUTE_NOT_FOUND' });
      status = 404;
    } else if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      domain = new DomainError('VALIDATION_FAILED', 'The request is malformed.', { reasonCode: 'MALFORMED_REQUEST' });
      status = 400;
    } else {
      // Never log request content or token material; the correlation id ties the opaque 500 to server logs.
      req.log.error({ correlationId, errorName: (err as Error)?.name ?? 'unknown' }, 'unhandled API error');
      obs.logger?.errorFrom('http.unhandled_error', err, { correlationId });
      domain = new DomainError('INTERNAL', 'Internal error.');
      status = 500;
    }
    const retryAfterMs = domain.details.retryAfterMs;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs))
      void reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    void reply.status(status).send(toApiErrorBody(domain, correlationId));
  });
  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .send(
        toApiErrorBody(
          new DomainError('VALIDATION_FAILED', 'No such route.', { reasonCode: 'ROUTE_NOT_FOUND' }),
          req.ubCorrelationId ?? newId('correlation'),
        ),
      );
  });

  app.get('/health/live', async () => health.live());
  // Readiness is visible: degraded (a missed SLO, a non-critical failure) still serves 200 with the reason; an
  // unavailable critical dependency is 503. Check details never carry error text.
  app.get('/health/ready', async (_req, reply) => {
    const r = await health.ready();
    return reply.status(r.status === 'unavailable' ? 503 : 200).send(r);
  });
  app.get('/v1/public-config', async () => opts.publicConfig);

  registerFleetRoutes(app, deps);
  registerIncidentRoutes(app, deps);
  registerEvidenceRoutes(app, deps);
  registerCommerceRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  if (opts.webRoot) await registerStatic(app, opts.webRoot);

  await app.ready();
  return app;
}
