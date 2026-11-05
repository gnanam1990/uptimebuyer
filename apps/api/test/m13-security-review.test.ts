// M13 security review findings over the M13 diff (no database: in-memory pool and verifier). Each case was added red
// before its fix.
// S1 — unauthenticated provider callbacks shared the operator bulkhead: a flood of slow webhook deliveries (no bearer
// token needed, only a binding-shaped path) could occupy every slot and shed authenticated operator traffic with 429
// LOAD_SHED. Webhooks now have their own bulkhead, so callback pressure is shed on the callback surface only.
import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '@uptimebuyer/observability';
import { buildApiServer } from '../src/index.js';

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

describe('M13 security review S1: webhook pressure cannot shed operator traffic', () => {
  it('a slow callback flood is shed on the webhook surface while operator requests still run', async () => {
    const gates: (() => void)[] = [];
    // Webhook binding resolution hangs on the database until released; operator authentication fails fast.
    const pool = {
      query: (sql: string) =>
        /webhook|provider_account/i.test(sql)
          ? new Promise((resolve) => gates.push(() => resolve({ rows: [], rowCount: 0 })))
          : Promise.resolve({ rows: [], rowCount: 0 }),
      connect: async () => {
        throw new Error('not used');
      },
    };
    const metrics = new MetricsRegistry();
    const app = await buildApiServer({
      pool: pool as never,
      verifier: { verify: async () => Promise.reject(new Error('invalid token')) } as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
      observability: { metrics },
      limits: { maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 5_000 },
    });
    const binding = 'whb_' + 'a'.repeat(40);
    const hook = () =>
      app.inject({
        method: 'POST',
        url: `/v1/fulfillment-webhooks/${binding}`,
        headers: {
          'content-type': 'application/json',
          'x-ub-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
        payload: '{}',
      });
    const slow = hook();
    await new Promise((r) => setTimeout(r, 30));
    const shedHook = await hook();
    expect(shedHook.statusCode).toBe(429);
    const bearer = { authorization: `Bearer ${['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('.')}` };
    const operator = await app.inject({ method: 'GET', url: '/v1/incidents', headers: bearer });
    expect(operator.statusCode).toBe(401);
    gates.splice(0).forEach((g) => g());
    await slow;
    expect(metrics.value('ub_load_shed_total', { bound: 'webhook' })).toBe(1);
    await app.close();
  });
});

// S7 — bulkhead slots could leak: release ran only from response hooks and onRequestAbort, so a client that
// disconnected while its acquire was still queued (or on a lifecycle path where the abort hook does not run) kept the
// slot forever; repeated early disconnects exhausted the cap. Unauthenticated requests also held operator capacity
// while being authenticated. Release is now tied to the response's close, a request that is already gone when its slot
// is granted gives it back at once, a queued waiter that disconnects leaves the queue, and slots are taken only after
// authentication (anonymous traffic never occupies operator capacity).
describe('M13 security review S7: bulkhead slots cannot leak and anonymous traffic holds none', () => {
  const http = async () => await import('node:http');
  const pool = (opts: { authenticated: boolean }) => ({
    query: async (sql: string) => {
      if (!opts.authenticated) return { rows: [], rowCount: 0 };
      if (/FROM users/.test(sql))
        return { rows: [{ id: 'usr_s7-0001', issuer: PUBLIC.oidc.issuer, status: 'ACTIVE' }], rowCount: 1 };
      if (/tenant_memberships/.test(sql)) return { rows: [{ tenant_id: 'ten_s7-0001' }], rowCount: 1 };
      if (/FROM tenants/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/role_assignments/.test(sql))
        return { rows: [{ id: 'rla_s7-0001', role: 'viewer', site_id: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
  });
  const token = (tag: string) => ['eyJ' + 'a'.repeat(20), tag.padEnd(20, 'b'), 'c'.repeat(20)].join('.');

  it('aborts while queued and while in flight return every slot; a later request is admitted', async () => {
    const { request } = await http();
    // Authentication succeeds; the route's own work hangs while `hang` is set, so requests hold (or queue for) slots.
    let hang = true;
    const base = pool({ authenticated: true });
    const hanging = {
      query: base.query,
      connect: async () => ({
        query: (sql: string) =>
          hang && /incidents/.test(sql) ? new Promise<never>(() => {}) : Promise.resolve({ rows: [], rowCount: 0 }),
        release() {},
      }),
    };
    const app = await buildApiServer({
      pool: hanging as never,
      verifier: { verify: async () => ({ issuer: PUBLIC.oidc.issuer, subject: 's7' }) } as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
      limits: { maxConcurrentRequests: 1, maxQueuedRequests: 2, queueTimeoutMs: 30_000 },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const fire = () => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/v1/incidents',
        headers: { authorization: `Bearer ${token('x')}` },
      });
      req.on('error', () => {});
      req.end();
      return req;
    };
    for (let round = 0; round < 5; round++) {
      // One in flight, two queued; every client disconnects.
      const reqs = [fire(), fire(), fire()];
      await new Promise((r) => setTimeout(r, 60));
      reqs.forEach((r) => r.destroy());
      await new Promise((r) => setTimeout(r, 60));
    }
    hang = false;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/incidents',
      headers: { authorization: `Bearer ${token('good')}` },
    });
    expect(res.statusCode).not.toBe(429);
    await app.close();
  });

  it('an anonymous flood stuck in authentication does not shed an authenticated request', async () => {
    const verifier = {
      verify: (tk: string) =>
        tk.includes('good')
          ? Promise.resolve({ issuer: PUBLIC.oidc.issuer, subject: 's7' })
          : new Promise<never>(() => {}),
    };
    const app = await buildApiServer({
      pool: pool({ authenticated: true }) as never,
      verifier: verifier as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
      limits: { maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 5_000 },
    });
    for (let i = 0; i < 5; i++)
      void app.inject({
        method: 'GET',
        url: '/v1/incidents',
        headers: { authorization: `Bearer ${token(`anon${i}`)}` },
      });
    await new Promise((r) => setTimeout(r, 30));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/incidents',
      headers: { authorization: `Bearer ${token('good')}` },
    });
    expect(res.statusCode).not.toBe(429);
    await app.close();
  });
});
