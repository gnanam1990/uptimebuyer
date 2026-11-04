// Sensor gateway HTTP surface (ADR 0001 §4, API-EVENT-SPEC POST /v1/device/telemetry:batch, TDD §6).
// Request path: size-bounded raw body -> device token (single-use, @uptimebuyer/data authenticateDevice) -> tenant
// from the device's own row (X-Tenant-ID may only name it) -> HMAC body signature + signing-time skew bound ->
// strict bounded schema -> per-device rate bucket (separate live and backfill budgets) -> bounded live-first
// scheduler -> ingestTelemetryBatch. The tenant, site, asset and revisions are never taken from the payload.
import { createHash } from 'node:crypto';
import { DomainError, newId, toApiErrorBody, type CorrelationId, type UtcInstant } from '@uptimebuyer/contracts';
import {
  authenticateDevice,
  ingestTelemetryBatch,
  peekMachineTokenSubject,
  resolveDeviceCredentialKey,
  resolveTenantContext,
  verifyMachineTokenOffline,
  verifyDeviceBodySignature,
  type CredentialResolver,
  type Db,
  type TelemetryIngestResult,
} from '@uptimebuyer/data';
import {
  DEFAULT_FRESHNESS_POLICY,
  DEFAULT_LATENESS_POLICY,
  FreshnessPolicySchema,
  LatenessPolicySchema,
  SIGNATURE_HEADER,
  TELEMETRY_LIMITS,
  TIMESTAMP_HEADER,
  decodeTelemetryBatch,
  parseTimestampHeader,
  systemClock,
  type Clock,
  type FreshnessPolicy,
  type IngestionClass,
  type LatenessPolicy,
} from '@uptimebuyer/telemetry';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { IngestScheduler, KnownCredentials, RateBuckets, type Priority, type RateBucketConfig } from './scheduler.js';

export interface GatewayLimits {
  maxBodyBytes: number;
  maxSkewMs: number;
  maxConcurrentIngest: number;
  maxQueuedLive: number;
  maxQueuedBackfill: number;
  liveRate: RateBucketConfig;
  backfillRate: RateBucketConfig;
  /** Coarse budget of unauthenticated attempts per source address (only failures are kept; successes refund). */
  preAuthRate: RateBucketConfig;
  /** Budget of failed authentications per claimed device credential (kid). */
  credentialFailureRate: RateBucketConfig;
  /** How long a credential learned from a successful authentication is recognised in memory. */
  credentialCacheTtlMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = Object.freeze({
  maxBodyBytes: TELEMETRY_LIMITS.maxBodyBytes,
  maxSkewMs: TELEMETRY_LIMITS.maxSkewMs,
  maxConcurrentIngest: 8,
  maxQueuedLive: 512,
  maxQueuedBackfill: 64,
  liveRate: { capacityMessages: 600, refillMessagesPerSecond: 20 },
  backfillRate: { capacityMessages: 400, refillMessagesPerSecond: 20 },
  preAuthRate: { capacityMessages: 60, refillMessagesPerSecond: 1, maxTrackedKeys: 50_000 },
  credentialFailureRate: { capacityMessages: 10, refillMessagesPerSecond: 0.2, maxTrackedKeys: 100_000 },
  credentialCacheTtlMs: 600_000,
});

export interface GatewayOptions {
  pool: Db;
  credentials: CredentialResolver;
  clock?: Clock;
  latenessPolicy?: LatenessPolicy;
  freshnessPolicy?: FreshnessPolicy;
  limits?: Partial<GatewayLimits>;
  logger?: boolean;
  /**
   * Proxy trust for the source address used by the per-source budget (Fastify `trustProxy`). Default false: the
   * socket address. Set it explicitly to the proxy addresses when the gateway sits behind a load balancer.
   */
  trustProxy?: boolean | string | string[];
}

export interface GatewayMetrics {
  requests: number;
  accepted: Record<IngestionClass, number>;
  duplicates: number;
  rejectedSamples: Record<string, number>;
  deniedRequests: Record<string, number>;
  rateLimited: number;
  backpressure: number;
  disclosuresRecorded: number;
  /** Receipt-minus-source lag of the newest accepted LIVE sample (ms). */
  lastLiveLagMs: number | null;
  queue: { running: number; live: number; backfill: number };
}

export interface SensorGateway {
  app: FastifyInstance;
  metrics(): GatewayMetrics;
  close(): Promise<void>;
}

const ROUTE = '/v1/device/telemetry::batch';

declare module 'fastify' {
  interface FastifyRequest {
    ubReceivedAtMs: number;
    ubCorrelationId: CorrelationId;
  }
}

const unauthenticated = (reasonCode?: string) =>
  new DomainError('UNAUTHENTICATED', 'Authentication failed.', reasonCode ? { reasonCode } : {});

export async function buildSensorGateway(opts: GatewayOptions): Promise<SensorGateway> {
  const clock = opts.clock ?? systemClock;
  const limits: GatewayLimits = { ...DEFAULT_GATEWAY_LIMITS, ...opts.limits };
  const lateness = LatenessPolicySchema.parse(opts.latenessPolicy ?? DEFAULT_LATENESS_POLICY);
  const freshness = FreshnessPolicySchema.parse(opts.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY);
  const scheduler = new IngestScheduler({
    maxConcurrent: limits.maxConcurrentIngest,
    maxQueuedLive: limits.maxQueuedLive,
    maxQueuedBackfill: limits.maxQueuedBackfill,
  });
  const buckets: Record<Priority, RateBuckets> = {
    LIVE: new RateBuckets(limits.liveRate, clock),
    BACKFILL: new RateBuckets(limits.backfillRate, clock),
  };
  const preAuth = new RateBuckets(limits.preAuthRate, clock);
  const credentialFailures = new RateBuckets(limits.credentialFailureRate, clock);
  const credentials = new KnownCredentials(clock, {
    ttlMs: limits.credentialCacheTtlMs,
    maxKeys: 100_000,
    maxSeenTokens: 200_000,
  });
  const m: Omit<GatewayMetrics, 'queue'> = {
    requests: 0,
    accepted: { LIVE: 0, LATE: 0, BACKFILL: 0 },
    duplicates: 0,
    rejectedSamples: {},
    deniedRequests: {},
    rateLimited: 0,
    backpressure: 0,
    disclosuresRecorded: 0,
    lastLiveLagMs: null,
  };
  const bump = (rec: Record<string, number>, k: string) => (rec[k] = (rec[k] ?? 0) + 1);

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: limits.maxBodyBytes,
    trustProxy: opts.trustProxy ?? false,
    // never echo request content in framework errors
    return503OnClosing: true,
  });
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: limits.maxBodyBytes },
    (_req, body, done) => done(null, body),
  );
  app.addHook('onRequest', async (req, reply) => {
    req.ubReceivedAtMs = clock.now();
    req.ubCorrelationId = newId('correlation');
    void reply.header('x-correlation-id', req.ubCorrelationId);
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
    } else if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      domain = new DomainError('VALIDATION_FAILED', 'The request is malformed.', { reasonCode: 'MALFORMED_REQUEST' });
      status = 400;
    } else {
      domain = new DomainError('INTERNAL', 'Internal error.');
      status = 500;
    }
    bump(m.deniedRequests, (domain.details.reasonCode as string | undefined) ?? domain.code);
    const retryAfterMs = domain.details.retryAfterMs;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs))
      void reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    void reply.status(status).send(toApiErrorBody(domain, correlationId));
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
  // Metrics are process-wide (all tenants), so they are not served on this device-facing listener; the operator
  // reads `gateway.metrics()` in-process or exports it from a separate, authenticated operations listener.

  app.post(ROUTE, async (req, reply) => {
    m.requests++;
    const receivedAtMs = req.ubReceivedAtMs;
    const receivedAt = new Date(receivedAtMs).toISOString() as UtcInstant;
    const body = req.body;
    if (!Buffer.isBuffer(body))
      throw new DomainError('VALIDATION_FAILED', 'Expected a JSON request body.', { reasonCode: 'BODY_MISSING' });

    // 1. device identity (single-use short-lived token) and tenant from the device's own row.
    //    Failure budgets bound the database work unauthenticated traffic can cause, and are reserved synchronously
    //    BEFORE any await (no check-then-act window), refunded when authentication succeeds:
    //    - a token not even shaped like a device token spends the coarse per-source budget only;
    //    - a well-formed token that the gateway cannot already recognise as valid spends the budget of the
    //      credential it claims (kid) and the per-source budget;
    //    - a token verified in memory against a credential this gateway has already authenticated, with an unseen
    //      token id, spends nothing: other clients' failures can never block a valid, known device.
    const source = req.ip || 'unknown';
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]{1,4096})$/.exec(header) : null;
    const token = match ? match[1]! : null;
    const kid = token ? peekMachineTokenSubject('DEVICE', token) : null;
    let recognised = false;
    if (token && kid) {
      const known = credentials.get(kid);
      const offline = known ? await verifyMachineTokenOffline('DEVICE', token, known) : null;
      recognised = offline !== null && credentials.firstUse(offline.jti);
    }
    const reserved: [RateBuckets, string][] = [];
    if (!recognised) {
      const refuse = () => {
        for (const [b, k] of reserved) b.refund(k, 1);
        m.rateLimited++;
        return new DomainError('RATE_LIMITED', 'Too many failed authentications; retry later.', {
          reasonCode: 'AUTHENTICATION_RATE_EXCEEDED',
          retryAfterMs: Math.ceil(1000 / limits.preAuthRate.refillMessagesPerSecond),
        });
      };
      if (kid) {
        if (!credentialFailures.take(kid, 1).ok) throw refuse();
        reserved.push([credentialFailures, kid]);
      }
      if (!preAuth.take(source, 1).ok) throw refuse();
      reserved.push([preAuth, source]);
    }
    if (!token) throw unauthenticated();
    let auth;
    try {
      auth = await authenticateDevice(opts.pool, opts.credentials, token);
    } catch (e) {
      if (e instanceof DomainError) {
        if (kid && recognised) credentials.forget(kid); // e.g. revoked since it was learned
        throw unauthenticated();
      }
      for (const [b, k] of reserved) b.refund(k, 1);
      throw e;
    }
    for (const [b, k] of reserved) b.refund(k, 1);
    const tenantHeader = req.headers['x-tenant-id'];
    const ctx = await resolveTenantContext(
      opts.pool,
      auth,
      typeof tenantHeader === 'string'
        ? tenantHeader
        : Array.isArray(tenantHeader)
          ? tenantHeader.join(',')
          : undefined,
      { correlationId: req.ubCorrelationId },
    );
    if (!recognised && kid) {
      const key = await resolveDeviceCredentialKey(opts.pool, ctx, opts.credentials);
      if (key) credentials.remember(kid, key);
    }

    // 2. body signature over the exact bytes, bounded signing-time skew
    const ts = parseTimestampHeader(req.headers[TIMESTAMP_HEADER]);
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const verdict = await verifyDeviceBodySignature(opts.pool, ctx, opts.credentials, {
      timestampMs: ts,
      body,
      signature: typeof sigHeader === 'string' ? sigHeader : undefined,
      nowMs: receivedAtMs,
      maxSkewMs: limits.maxSkewMs,
    });
    if (!verdict.ok)
      throw unauthenticated(verdict.reasonCode === 'TIMESTAMP_SKEW' ? 'TIMESTAMP_SKEW' : 'SIGNATURE_INVALID');

    // 3. strict, bounded schema
    const decoded = decodeTelemetryBatch(body);
    if (!decoded.ok) {
      if (decoded.reasonCode === 'BODY_TOO_LARGE')
        throw Object.assign(new Error('too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
      throw new DomainError('VALIDATION_FAILED', 'Telemetry batch failed contract validation.', {
        reasonCode: decoded.reasonCode,
        ...(decoded.fieldErrors ? { fieldErrors: decoded.fieldErrors } : {}),
      });
    }
    const batch = decoded.batch;

    // 4. rate budget: live data is never starved by the same device's backfill
    const priority: Priority =
      batch.delivery === 'LIVE' &&
      batch.messages.every((msg) => receivedAtMs - Date.parse(msg.eventAt) <= lateness.liveMaxLagMs)
        ? 'LIVE'
        : 'BACKFILL';
    const take = buckets[priority].take(`${ctx.tenantId}/${ctx.principal.id}`, batch.messages.length);
    if (!take.ok) {
      m.rateLimited++;
      if (!Number.isFinite(take.retryAfterMs))
        throw new DomainError(
          'VALIDATION_FAILED',
          'Batch exceeds the per-device rate capacity; send smaller batches.',
          {
            reasonCode: 'BATCH_EXCEEDS_RATE_CAPACITY',
          },
        );
      throw new DomainError('RATE_LIMITED', 'Telemetry rate exceeded; retry later.', {
        reasonCode: priority === 'LIVE' ? 'LIVE_RATE_EXCEEDED' : 'BACKFILL_RATE_EXCEEDED',
        retryAfterMs: take.retryAfterMs,
      });
    }

    // 5. bounded, live-first ingestion
    let result: TelemetryIngestResult;
    try {
      result = await scheduler.schedule(priority, () =>
        ingestTelemetryBatch(
          opts.pool,
          ctx,
          {
            batch,
            receivedAt,
            signedAt: new Date(ts).toISOString() as UtcInstant,
            bodyDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          },
          { latenessPolicy: lateness, freshnessPolicy: freshness },
        ),
      );
    } catch (e) {
      if (e instanceof DomainError && e.details.reasonCode === 'INGEST_QUEUE_FULL') m.backpressure++;
      throw e;
    }
    for (const [cls, n] of Object.entries(result.classCounts)) m.accepted[cls as IngestionClass] += n;
    m.duplicates += result.duplicates;
    m.disclosuresRecorded += result.disclosures.recorded;
    for (const r of result.results) if (r.status === 'REJECTED' && r.reasonCode) bump(m.rejectedSamples, r.reasonCode);
    const liveTimes = result.results
      .filter((r) => r.status === 'ACCEPTED' && r.ingestionClass === 'LIVE')
      .map((r) => batch.messages.find((x) => x.bootId === r.bootId && x.sequence === r.sequence)!.eventAt)
      .sort();
    if (liveTimes.length > 0) m.lastLiveLagMs = receivedAtMs - Date.parse(liveTimes.at(-1)!);
    return reply.status(200).send(result);
  });

  const metrics = (): GatewayMetrics => ({ ...structuredClone(m), queue: scheduler.depth() });

  await app.ready();
  return {
    app,
    metrics,
    close: () => app.close(),
  };
}
