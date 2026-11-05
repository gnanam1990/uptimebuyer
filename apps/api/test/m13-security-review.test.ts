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
