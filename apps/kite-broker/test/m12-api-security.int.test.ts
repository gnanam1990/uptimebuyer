// M12 operator API security and contract tests (FR-19, NFR-05, INV-12, INV-16; API-EVENT-SPEC §1, §7, §8):
// - authentication is required on every /v1 route (missing, malformed, wrong-audience, wrong-issuer, expired and
//   unknown-subject tokens are one uniform 401) and repeated failures are rate limited per source;
// - request bodies and query strings are parsed strictly (unknown fields, a smuggled tenant/site/actor, wrong types,
//   non-JSON and oversized bodies are refused); mutations require Idempotency-Key and versioned commands If-Match;
// - a stale If-Match is a 409 VERSION_CONFLICT carrying the current version, and nothing is overwritten;
// - the fulfillment webhook route verifies the HMAC over the raw bytes, refuses unknown bindings and bad signatures
//   identically, deduplicates replays and bounds the payload;
// - authority issuance answers 202 without claiming the Kite session; responses carry security headers and a
//   correlation id, and never echo the bearer token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { FULFILLMENT_SIGNATURE_HEADER } from '@uptimebuyer/api';
import { signFulfillmentWebhook } from '@uptimebuyer/orders';
import { call, createApiWorld, errorOf, pendingApproval, type ApiWorld } from './m12-helpers.js';
import { eventBody, view } from './m10-helpers.js';
import { verifyingIncident, type VerifyingIncident } from './m11-helpers.js';

let w: ApiWorld;
let v: VerifyingIncident;

beforeAll(async () => {
  w = await createApiWorld('m12sec');
  v = await verifyingIncident(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const ROUTES: ['GET' | 'POST', string][] = [
  ['GET', '/v1/session'],
  ['GET', '/v1/fleet'],
  ['GET', '/v1/incidents'],
  ['GET', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000'],
  ['GET', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000/timeline'],
  ['GET', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000/evidence'],
  ['GET', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000/plans'],
  ['GET', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000/recovery'],
  ['GET', '/v1/execution-authorities/xau_00000000-0000-4000-8000-000000000000'],
  ['GET', '/v1/intents/cin_00000000-0000-4000-8000-000000000000'],
  ['GET', '/v1/purchase-orders/pur_00000000-0000-4000-8000-000000000000'],
  ['GET', '/v1/ledger'],
  ['GET', '/v1/audit'],
  ['GET', '/v1/policies'],
  ['GET', '/v1/notifications'],
  ['POST', '/v1/incidents/inc_00000000-0000-4000-8000-000000000000:assign'],
  ['POST', '/v1/plans/pln_00000000-0000-4000-8000-000000000000:approve'],
  ['POST', '/v1/approvals/apr_00000000-0000-4000-8000-000000000000/execution-authorities'],
  ['POST', '/v1/execution-authorities/xau_00000000-0000-4000-8000-000000000000:change-status'],
  ['POST', '/v1/policies'],
];

describe('M12 API authentication', () => {
  it('every /v1 route except public config and webhooks requires a valid bearer token (uniform 401)', async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(w.idp.issuer)
      .setAudience(w.idp.audience)
      .setSubject(w.subjects.admin!)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new Uint8Array(32));
    const tokens = [
      null,
      'not-a-jwt',
      forged,
      await w.idp.mint(w.subjects.admin!, { audience: 'some-other-api' }),
      await w.idp.mint(w.subjects.admin!, { issuer: 'https://evil.invalid/' }),
      await w.idp.mint(w.subjects.admin!, { expiresIn: '-1m' }),
      await w.idp.mint('subject-that-is-not-a-user'),
    ];
    for (const [method, url] of ROUTES)
      for (const token of tokens) {
        // A fresh server per token family would hide the rate limit; spread sources so it is not what answers here.
        const r = await w.app.inject({
          method,
          url,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'content-type': 'application/json',
            'idempotency-key': 'm12-auth-probe-0001',
          },
          payload: method === 'POST' ? '{}' : undefined,
          remoteAddress: `10.9.${ROUTES.findIndex((x) => x[1] === url)}.${tokens.indexOf(token)}`,
        });
        expect(r.statusCode, `${method} ${url}`).toBe(401);
        expect(r.json().error.code).toBe('UNAUTHENTICATED');
        if (token) expect(r.body).not.toContain(token);
      }
    expect((await w.app.inject({ method: 'GET', url: '/v1/public-config' })).statusCode).toBe(200);
  });

  it('repeated authentication failures from one source are rate limited (429 with Retry-After)', async () => {
    let limited = null;
    for (let i = 0; i < 60; i++) {
      const r = await w.app.inject({
        method: 'GET',
        url: '/v1/session',
        headers: { authorization: 'Bearer a.b.c' },
        remoteAddress: '10.77.0.1',
      });
      if (r.statusCode === 429) {
        limited = r;
        break;
      }
      expect(r.statusCode).toBe(401);
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers['retry-after']).toBeDefined();
    // A valid token from the same exhausted source is still refused until the budget refills.
    const ok = await w.app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { authorization: `Bearer ${await w.idp.mint(w.subjects.operator!)}` },
      remoteAddress: '10.77.0.1',
    });
    expect(ok.statusCode).toBe(429);
    // Other sources are unaffected.
    const other = await w.app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { authorization: `Bearer ${await w.idp.mint(w.subjects.operator!)}` },
      remoteAddress: '10.77.0.2',
    });
    expect(other.statusCode).toBe(200);
  });

  it('the session names the principal and tenant from the token, never from the request', async () => {
    const r = await call(w, w.subjects.operator!, 'GET', '/v1/session');
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.user.userId).toBe(w.people.operator!.userId);
    expect(s.tenant.tenantId).toBe(w.tenant.tenantId);
    expect(s.grants).toEqual(expect.arrayContaining([{ role: 'operator', siteId: w.siteId }]));
  });
});

describe('M12 API strict request parsing', () => {
  it('unknown fields, a smuggled tenant/site/actor, wrong types and non-JSON bodies are 400', async () => {
    const version = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${v.incidentId}`)).json().incident
      .version;
    const url = `/v1/incidents/${v.incidentId}:escalate`;
    for (const body of [
      { reasonCode: 'X', tenantId: w.tenant.tenantId },
      { reasonCode: 'X', siteId: w.siteId },
      { reasonCode: 'X', actorId: w.people.admin?.userId ?? 'usr_spoofed-0001' },
      { reasonCode: 42 },
      { reasonCode: 'lower case' },
      {},
      [],
    ]) {
      const r = errorOf(await call(w, w.subjects.operator!, 'POST', url, { body, version }));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.code).toBe('VALIDATION_FAILED');
    }
    const raw = errorOf(await call(w, w.subjects.operator!, 'POST', url, { rawBody: '{"reasonCode": ', version }));
    expect(raw).toMatchObject({ status: 400, reasonCode: 'BODY_NOT_JSON' });
    const big = errorOf(
      await call(w, w.subjects.operator!, 'POST', url, {
        rawBody: JSON.stringify({ reasonCode: 'X', pad: 'x'.repeat(80_000) }),
        version,
      }),
    );
    expect(big.status).toBe(413);
    const q = errorOf(await call(w, w.subjects.operator!, 'GET', '/v1/incidents?tenantId=ten_other-0001'));
    expect(q.status).toBe(400);
    expect((await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${v.incidentId}`)).json().incident.version).toBe(
      version,
    );
  });

  it('mutations require Idempotency-Key; versioned commands require If-Match', async () => {
    const url = `/v1/incidents/${v.incidentId}:escalate`;
    const version = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${v.incidentId}`)).json().incident
      .version;
    expect(
      errorOf(await call(w, w.subjects.operator!, 'POST', url, { body: { reasonCode: 'X' }, version, key: null })),
    ).toMatchObject({
      status: 400,
      reasonCode: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(
      errorOf(await call(w, w.subjects.operator!, 'POST', url, { body: { reasonCode: 'X' }, version: null })),
    ).toMatchObject({
      status: 400,
      reasonCode: 'IF_MATCH_REQUIRED',
    });
    expect(
      errorOf(await call(w, w.subjects.operator!, 'POST', url, { body: { reasonCode: 'X' }, version: 'W/"1"' })),
    ).toMatchObject({ status: 400, reasonCode: 'IF_MATCH_INVALID' });
  });

  it('a stale If-Match is 409 VERSION_CONFLICT with the current version; the winner is not overwritten', async () => {
    const p = await pendingApproval(w);
    const d = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${p.incidentId}`)).json();
    const v0 = d.incident.version as number;
    const first = await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${p.incidentId}:assign`, {
      body: { assigneeUserId: w.people.operator2!.userId, reasonCode: 'SHIFT_PLAN' },
      version: v0,
    });
    expect(first.statusCode).toBe(200);
    const stale = await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${p.incidentId}:assign`, {
      body: { assigneeUserId: w.people.operator!.userId, reasonCode: 'SHIFT_PLAN' },
      version: v0,
    });
    const e = errorOf(stale);
    expect(e.status).toBe(409);
    expect(e.code).toBe('VERSION_CONFLICT');
    expect(e.currentVersion).toBe(v0 + 1);
    const after = (await call(w, w.subjects.operator!, 'GET', `/v1/incidents/${p.incidentId}`)).json();
    expect(after.incident.currentAssignment.assigneeUserId).toBe(w.people.operator2!.userId);
    // Replaying the winning request with its own key returns the original result (idempotent).
    const replay = await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${p.incidentId}:assign`, {
      body: { assigneeUserId: w.people.operator2!.userId, reasonCode: 'SHIFT_PLAN' },
      version: v0,
      key: first.request.headers['idempotency-key'] as string,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().version).toBe(v0 + 1);
  });

  it('unknown routes and unknown command verbs are 404, not a fallthrough', async () => {
    expect((await call(w, w.subjects.operator!, 'POST', `/v1/incidents/${v.incidentId}:delete`)).statusCode).toBe(404);
    expect((await call(w, w.subjects.operator!, 'GET', '/v1/nope')).statusCode).toBe(404);
  });
});

describe('M12 fulfillment webhook route signature verification', () => {
  it('verifies the HMAC over the raw bytes, refuses unknown binding and bad signature identically, dedupes replays', async () => {
    const order = await view(w, v.orderId);
    const raw = Buffer.from(JSON.stringify(eventBody(order, 'delivered')), 'utf8');
    const ts = Math.floor(Date.now() / 1000);
    const good = signFulfillmentWebhook(w.account.verifierKey, ts, new Uint8Array(raw));
    const post = (binding: string, sig: string | null, body: Buffer = raw, ip = '10.55.0.1') =>
      w.app.inject({
        method: 'POST',
        url: `/v1/fulfillment-webhooks/${binding}`,
        headers: { 'content-type': 'application/json', ...(sig ? { [FULFILLMENT_SIGNATURE_HEADER]: sig } : {}) },
        payload: body,
        remoteAddress: ip,
      });
    const badSig = signFulfillmentWebhook(new Uint8Array(32).fill(7), ts, new Uint8Array(raw));
    const tampered = Buffer.from(raw.toString('utf8').replace('delivered', 'cancelled'));
    const results = [
      await post(w.account.binding, badSig),
      await post(w.account.binding, good, tampered),
      await post(w.account.binding, null),
      await post('UnknownBindingValue0000000000000', good),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHENTICATED');
    }
    const ok = await post(w.account.binding, good);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ACCEPTED');
    const again = await post(w.account.binding, good);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('DUPLICATE');
    const stale = signFulfillmentWebhook(w.account.verifierKey, ts - 3_600, new Uint8Array(raw));
    expect((await post(w.account.binding, stale)).statusCode).toBe(401);
    const huge = Buffer.alloc(70 * 1024, 0x20);
    expect(
      (await post(w.account.binding, signFulfillmentWebhook(w.account.verifierKey, ts, new Uint8Array(huge)), huge))
        .statusCode,
    ).toBe(413);
    // The webhook route takes no bearer token and a body cannot choose a tenant.
    const withTenant = Buffer.from(JSON.stringify({ ...eventBody(order, 'delivered'), tenantId: w.tenantB.tenantId }));
    const r = await post(
      w.account.binding,
      signFulfillmentWebhook(w.account.verifierKey, ts, new Uint8Array(withTenant)),
      withTenant,
    );
    expect([200, 202, 401]).toContain(r.statusCode);
    expect(JSON.stringify(r.json())).not.toContain(w.tenantB.tenantId);
  });
});

describe('M12 authority issuance honesty and response hardening', () => {
  it('issuance answers 202 and never reports a session it has not observed as confirmed', async () => {
    const p = await pendingApproval(w);
    const appr = await call(w, w.subjects.approver!, 'POST', `/v1/plans/${p.planId}:approve`, {
      body: { approvalRequestId: p.approvalRequestId, planHash: p.planHash },
    });
    const approvalId = appr.json().approvalId as string;
    const r = await call(w, w.subjects.operator!, 'POST', `/v1/approvals/${approvalId}/execution-authorities`, {
      body: { subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
    });
    expect(r.statusCode).toBe(202);
    const b = r.json();
    expect(b.accepted).toBe(true);
    expect(b.sessionConfirmed).toBe(false);
    expect(b.authority.session.externalOutcomeState).not.toBe('CONFIRMED');
    expect(b.authority.executable).toBe(false);
    expect(w.sessions).toContainEqual({
      tenantId: w.tenant.tenantId,
      executionAuthorityId: b.authority.authority.executionAuthorityId,
    });
    expect(JSON.stringify(b)).not.toMatch(/privateKey|signature_value|secretref:/);
  });

  it('every response carries a correlation id and strict security headers', async () => {
    for (const r of [
      await call(w, w.subjects.operator!, 'GET', '/v1/session'),
      await call(w, null, 'GET', '/v1/session'),
      await w.app.inject({ method: 'GET', url: '/v1/public-config' }),
    ]) {
      expect(r.headers['x-correlation-id']).toMatch(/^corr_/);
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect((await call(w, w.subjects.operator!, 'GET', '/v1/session')).headers['cache-control']).toBe('no-store');
  });

  it('an internal error is opaque: no stack, no SQL, no token', async () => {
    const token = await w.idp.mint(w.subjects.operator!);
    const r = await w.app.inject({
      method: 'GET',
      url: `/v1/incidents/${'inc_' + 'a'.repeat(300)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect([403, 404]).toContain(r.statusCode);
    expect(r.body).not.toContain(token);
    expect(r.body).not.toMatch(/SELECT|stack|at Object\./);
  });
});
