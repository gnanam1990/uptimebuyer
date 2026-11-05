// T-055 / T-054 at the operator API boundary (no database: an in-memory pool and verifier stand in). Every request
// emits one redacted structured log line, a bounded-label metric and an `http.request` span that continues an inbound
// W3C traceparent; the correlation id returned to the caller is the one in the log and the span. Readiness aggregates
// the database check and SLO state (degraded is visible, a dead database is 503). Concurrent /v1 work beyond the
// declared bulkhead is shed explicitly with 429 LOAD_SHED and Retry-After (NFR-04). The separate operations listener
// serves Prometheus metrics and firing alerts only to a bearer holding the operations token.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HealthRegistry,
  MemoryExporter,
  MemorySink,
  MetricsRegistry,
  SloTracker,
  StructuredLogger,
  Tracer,
  platformMetrics,
} from '@uptimebuyer/observability';
import { buildApiServer, buildOperationsServer } from '../src/index.js';

const PUBLIC = {
  oidc: {
    issuer: 'https://idp.test.invalid/',
    authorizationEndpoint: 'https://idp.test.invalid/authorize',
    tokenEndpoint: 'https://idp.test.invalid/token',
    clientId: 'uptimebuyer-web',
    audience: 'uptimebuyer-api',
    scope: 'openid',
  },
  environmentLabel: 'SEEDED_TEST_DATA',
} as const;

function harness(opts: { dbUp?: () => boolean; verify?: () => Promise<never>; limits?: object } = {}) {
  const sink = new MemorySink();
  const exporter = new MemoryExporter();
  const metrics = new MetricsRegistry();
  const slo = new SloTracker({ minSamples: 1 });
  const pool = {
    query: async () => {
      if (opts.dbUp && !opts.dbUp()) throw new Error('connect ECONNREFUSED secret-host:5432');
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    connect: async () => {
      throw new Error('not used');
    },
  };
  const verifier = {
    verify: opts.verify ?? (async () => Promise.reject(new Error('invalid token'))),
  };
  return {
    sink,
    exporter,
    metrics,
    slo,
    build: () =>
      buildApiServer({
        pool: pool as never,
        verifier: verifier as never,
        publicConfig: PUBLIC,
        store: {} as never,
        credentials: { resolveSigningKey: async () => null } as never,
        observability: {
          logger: new StructuredLogger({ service: 'api', sink: sink.write }),
          metrics,
          tracer: new Tracer({ service: 'api', exporter: exporter.export }),
          slo,
        },
        ...(opts.limits ? { limits: opts.limits } : {}),
      }),
  };
}

describe('T-055 API request logs, metrics and traces', () => {
  it('continues an inbound traceparent and ties log, span, metric and response to one correlation id', async () => {
    const h = harness();
    const app = await h.build();
    const traceId = randomBytes(16).toString('hex');
    const parent = randomBytes(8).toString('hex');
    const r = await app.inject({
      method: 'GET',
      url: '/v1/public-config',
      headers: { traceparent: `00-${traceId}-${parent}-01` },
    });
    expect(r.statusCode).toBe(200);
    const corr = r.headers['x-correlation-id'] as string;
    expect(corr).toMatch(/^corr_/);
    expect(String(r.headers.traceparent)).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    const rec = h.sink.records().find((x) => x.event === 'http.request')!;
    expect(rec).toMatchObject({
      service: 'api',
      correlationId: corr,
      routeClass: 'public',
      method: 'GET',
      status: 200,
    });
    expect(typeof rec.latencyMs).toBe('number');
    const span = h.exporter.spans.find((s) => s.name === 'http.request')!;
    expect(span).toMatchObject({ traceId, parentSpanId: parent, correlationId: corr, status: 'OK' });
    expect(h.metrics.value('ub_http_requests_total', { route_class: 'public', status_class: '2xx' })).toBe(1);
    await app.close();
  });

  it('logs a refused request without the credential it carried', async () => {
    const h = harness();
    const app = await h.build();
    const token = [
      'eyJhbGciOiJFUzI1NiJ9',
      randomBytes(30).toString('base64url'),
      randomBytes(40).toString('base64url'),
    ].join('.');
    const r = await app.inject({ method: 'GET', url: '/v1/incidents', headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(401);
    const all = h.sink.lines.join('\n');
    expect(all).not.toContain(token.split('.')[1]!);
    expect(all).not.toContain(token.split('.')[2]!);
    expect(h.sink.records().find((x) => x.event === 'http.request')).toMatchObject({ routeClass: 'read', status: 401 });
    expect(h.metrics.value('ub_http_requests_total', { route_class: 'read', status_class: '4xx' })).toBe(1);
    expect(h.exporter.spans.find((s) => s.name === 'http.request')?.status).toBe('REJECTED');
    await app.close();
  });
});

describe('T-055 readiness with visible degraded state (NFR-08)', () => {
  it('reports ready, then degraded on a missed SLO, then 503 when the database is down — without leaking errors', async () => {
    let up = true;
    const h = harness({ dbUp: () => up });
    const app = await h.build();
    let r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ready' });
    h.slo.record('operator_read', 5_000);
    r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'degraded' });
    expect(JSON.stringify(r.json())).toContain('operator_read');
    up = false;
    r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('unavailable');
    expect(r.body).not.toContain('secret-host');
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('T-054 API load shedding (NFR-04)', () => {
  it('admits exactly the declared concurrency + queue and sheds the next /v1 request with 429 LOAD_SHED', async () => {
    const gates: (() => void)[] = [];
    const h = harness({
      verify: () =>
        new Promise<never>((_resolve, reject) => {
          gates.push(() => reject(new Error('invalid token')));
        }),
      limits: { maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 5_000 },
    });
    const app = await h.build();
    const bearer = { authorization: `Bearer ${['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('.')}` };
    const first = app.inject({ method: 'GET', url: '/v1/incidents', headers: bearer });
    await new Promise((r) => setTimeout(r, 20));
    const second = app.inject({ method: 'GET', url: '/v1/incidents', headers: bearer });
    await new Promise((r) => setTimeout(r, 20));
    const third = await app.inject({ method: 'GET', url: '/v1/incidents', headers: bearer });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.reasonCode).toBe('LOAD_SHED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Health and public configuration are never shed.
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    gates.shift()!();
    expect((await first).statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    gates.shift()!();
    expect((await second).statusCode).toBe(401);
    expect(h.metrics.value('ub_load_shed_total', { bound: 'api_requests' })).toBe(1);
    await app.close();
  });
});

describe('T-055 operations listener', () => {
  it('serves metrics and firing alerts only with the operations token and readiness without it', async () => {
    const metrics = new MetricsRegistry();
    const p = platformMetrics(metrics);
    p.outboxOldestAgeSeconds.set({}, 120);
    const health = new HealthRegistry();
    health.register('database', async () => ({ status: 'pass' }), { critical: true });
    const token = randomBytes(32).toString('base64url');
    const ops = await buildOperationsServer({ metrics, health, token });
    expect((await ops.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect(
      (await ops.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${token}x` } })).statusCode,
    ).toBe(401);
    const m = await ops.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${token}` } });
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toMatch(/^text\/plain/);
    expect(m.body).toContain('ub_outbox_oldest_unpublished_age_seconds 120');
    const a = await ops.inject({ method: 'GET', url: '/alerts', headers: { authorization: `Bearer ${token}` } });
    expect(a.json().firing.map((x: { id: string }) => x.id)).toEqual(['outbox_or_queue_age']);
    const ready = await ops.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
    await expect(buildOperationsServer({ metrics, health, token: 'short' })).rejects.toThrow();
    await ops.close();
  });
});
