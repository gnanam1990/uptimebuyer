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
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticate } from './auth.js';
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
}

export const DEFAULT_API_LIMITS: ApiLimits = Object.freeze({
  bodyLimitBytes: 64 * 1024,
  webhookBodyLimitBytes: 64 * 1024,
  authFailures: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  sensitiveCommands: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  webhookFailures: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
});

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
  const tokenOrigin = new URL(opts.publicConfig.oidc.tokenEndpoint).origin;
  const headers = securityHeaders(contentSecurityPolicy([tokenOrigin]));

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
    void reply.header(CORRELATION_HEADER, req.ubCorrelationId);
    for (const [k, v] of Object.entries(headers)) void reply.header(k, v);
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/v1/')) void reply.header('cache-control', 'no-store');
    if (path.startsWith('/v1/') && !PUBLIC_PATHS.has(path) && !path.startsWith('/v1/fulfillment-webhooks/'))
      req.ubCtx = await authenticate({ pool: opts.pool, verifier: opts.verifier, failures }, req, req.ubCorrelationId);
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

  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await opts.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
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
