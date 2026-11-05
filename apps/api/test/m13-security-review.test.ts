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

// Shared fakes for S7/S11: an authenticating in-memory pool, bearer-shaped tokens and the http module.
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

// S11 — authenticating before taking a slot (S7) left unauthenticated work unbounded: the per-source failure limiter
// was checked with has() and charged only after a failure, so N concurrent bad tokens from one source all passed the
// check and ran verification and database work at once. A failure token is now reserved atomically before
// verification (refunded on success), verification runs under a per-source and a global pre-auth cap released once on
// close, and every excess request gets the same 429 body as any other authentication rate limit (no oracle).
describe('M13 security review S11: bounded pre-authentication work', () => {
  function verifierProbe() {
    const gates: (() => void)[] = [];
    const stats = { inFlight: 0, max: 0, calls: 0 };
    return {
      gates,
      stats,
      verify: (tk: string) => {
        if (tk.includes('good')) return Promise.resolve({ issuer: PUBLIC.oidc.issuer, subject: 's11' });
        stats.calls++;
        stats.inFlight++;
        stats.max = Math.max(stats.max, stats.inFlight);
        return new Promise<never>((_r, reject) =>
          gates.push(() => {
            stats.inFlight--;
            reject(new Error('invalid token'));
          }),
        );
      },
    };
  }
  const authPool = pool({ authenticated: true });

  it('200 concurrent bad tokens from one source: verification stays under the cap, excess gets the uniform 429, the source is then limited, another source is admitted', async () => {
    const v = verifierProbe();
    const app = await buildApiServer({
      pool: authPool as never,
      verifier: { verify: v.verify } as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
    });
    const bad = (i: number) =>
      app.inject({
        method: 'GET',
        url: '/v1/incidents',
        remoteAddress: '10.9.9.9',
        headers: { authorization: `Bearer ${token(`bad${i}`)}` },
      });
    const burst = Array.from({ length: 200 }, (_, i) => bad(i));
    await new Promise((r) => setTimeout(r, 50));
    expect(v.stats.max).toBeLessThanOrEqual(8);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/incidents',
      remoteAddress: '10.1.1.1',
      headers: { authorization: `Bearer ${token('good')}` },
    });
    expect(other.statusCode).not.toBe(429);
    while (v.gates.length) v.gates.shift()!();
    const results = await Promise.all(burst);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(limited.length).toBeGreaterThanOrEqual(190);
    const bodies = new Set(limited.map((r) => JSON.stringify({ ...r.json().error, correlationId: undefined })));
    expect(bodies.size).toBe(1);
    expect(limited[0]!.json().error.reasonCode).toBe('AUTHENTICATION_RATE_EXCEEDED');
    expect(results.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(8);
    expect(v.stats.calls).toBeLessThanOrEqual(30);
    expect((await bad(999)).statusCode).toBe(429);
    await app.close();
  });

  it('every pre-auth slot returns after clients abort mid-verification', async () => {
    const { request } = await http();
    const v = verifierProbe();
    const app = await buildApiServer({
      pool: authPool as never,
      verifier: { verify: v.verify } as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
      limits: { authFailures: { capacity: 10_000, refillPerSecond: 100, maxKeys: 100 } },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    for (let round = 0; round < 4; round++) {
      const reqs = Array.from({ length: 12 }, (_, i) => {
        const r = request({
          host: '127.0.0.1',
          port,
          path: '/v1/incidents',
          headers: { authorization: `Bearer ${token(`x${round}${i}`)}` },
        });
        r.on('error', () => {});
        r.end();
        return r;
      });
      await new Promise((r) => setTimeout(r, 60));
      reqs.forEach((r) => r.destroy());
      await new Promise((r) => setTimeout(r, 60));
    }
    // The verifications are still pending (their promises never settled), yet the source may verify again.
    const before = v.stats.calls;
    const next = await new Promise<number>((resolve) => {
      const r = request(
        { host: '127.0.0.1', port, path: '/v1/incidents', headers: { authorization: `Bearer ${token('xnext')}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on('error', () => resolve(-1));
      r.end();
      setTimeout(() => {
        while (v.gates.length) v.gates.shift()!();
      }, 100);
    });
    expect(v.stats.calls).toBe(before + 1);
    expect(next).toBe(401);
    await app.close();
  });
});

// S12 — the pre-auth slot was freed on client close while verification kept running, so open-then-abort bursts ran
//      unbounded concurrent verifications; a hung verifier held its slot forever. The slot now lives exactly as long
//      as the verification (released once when it settles, never on close) and verification has a hard timeout.
// S13 — a handful of sources could fill the global pre-auth cap and lock every operator out, and an IPv6 attacker
//      could rotate addresses for fresh buckets. Sources are keyed by IPv4 /32 and IPv6 /64, the global cap is sized
//      well above per-source x expected sources (configurable) and briefly queues instead of rejecting at once.
//      Residual (ADR 0008): a large distributed pool can still saturate any in-process cap; edge/WAF limits are M14's.
describe('M13 security review S12/S13: pre-auth slots follow the verification; caps resist lockout', () => {
  function hungVerifier() {
    const stats = { inFlight: 0, max: 0, calls: 0 };
    return {
      stats,
      verify: (tk: string) => {
        if (tk.includes('good')) return Promise.resolve({ issuer: PUBLIC.oidc.issuer, subject: 's12' });
        stats.calls++;
        stats.inFlight++;
        stats.max = Math.max(stats.max, stats.inFlight);
        return new Promise<never>(() => {});
      },
    };
  }
  const server = (verifier: { verify: (tk: string) => Promise<unknown> }, limits: object = {}) =>
    buildApiServer({
      pool: pool({ authenticated: true }) as never,
      verifier: verifier as never,
      publicConfig: PUBLIC,
      store: {} as never,
      credentials: { resolveSigningKey: async () => null } as never,
      limits: { authFailures: { capacity: 100_000, refillPerSecond: 1_000, maxKeys: 1_000 }, ...limits },
    });

  it('open-then-abort bursts never push in-flight verifications above the per-source cap', async () => {
    const { request } = await http();
    const v = hungVerifier();
    const app = await server(v, { authTimeoutMs: 60_000 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    for (let round = 0; round < 6; round++) {
      const reqs = Array.from({ length: 20 }, (_, i) => {
        const r = request({
          host: '127.0.0.1',
          port,
          path: '/v1/incidents',
          headers: { authorization: `Bearer ${token(`burst${round}-${i}`)}` },
        });
        r.on('error', () => {});
        r.end();
        return r;
      });
      await new Promise((r) => setTimeout(r, 40));
      reqs.forEach((r) => r.destroy());
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(v.stats.max).toBeLessThanOrEqual(8);
    await app.close();
  });

  it('a hung verifier frees its slot after the verification timeout', async () => {
    const v = hungVerifier();
    const app = await server(v, { authTimeoutMs: 150, maxConcurrentAuthPerSource: 1 });
    const call = (tag: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/incidents',
        remoteAddress: '10.5.5.5',
        headers: { authorization: `Bearer ${token(tag)}` },
      });
    const first = await call('hung-1');
    expect(first.statusCode).toBe(401);
    const second = await call('hung-2');
    expect(second.statusCode).toBe(401);
    expect(v.stats.calls).toBe(2);
    await app.close();
  });

  it('k attacking sources at their per-source cap leave room for a legitimate operator (default sizing)', async () => {
    const v = hungVerifier();
    const app = await server(v, { authTimeoutMs: 60_000 });
    for (let k = 0; k < 10; k++)
      for (let i = 0; i < 12; i++)
        void app.inject({
          method: 'GET',
          url: '/v1/incidents',
          remoteAddress: `10.0.${k}.1`,
          headers: { authorization: `Bearer ${token(`att${k}-${i}`)}` },
        });
    await new Promise((r) => setTimeout(r, 50));
    expect(v.stats.max).toBeLessThanOrEqual(10 * 8);
    const legit = await app.inject({
      method: 'GET',
      url: '/v1/incidents',
      remoteAddress: '192.0.2.10',
      headers: { authorization: `Bearer ${token('good')}` },
    });
    expect(legit.statusCode).not.toBe(429);
    await app.close();
  });

  it('an IPv6 attacker rotating addresses within one /64 shares one bucket', async () => {
    const v = hungVerifier();
    const app = await server(v, { authTimeoutMs: 60_000 });
    const results = Array.from({ length: 30 }, (_, i) =>
      app.inject({
        method: 'GET',
        url: '/v1/incidents',
        remoteAddress: `2001:db8:1:2::${(i + 1).toString(16)}`,
        headers: { authorization: `Bearer ${token(`v6-${i}`)}` },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(v.stats.max).toBeLessThanOrEqual(8);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/incidents',
      remoteAddress: '2001:db8:1:3::1',
      headers: { authorization: `Bearer ${token('good')}` },
    });
    expect(other.statusCode).not.toBe(429);
    void results;
    await app.close();
  });
});
