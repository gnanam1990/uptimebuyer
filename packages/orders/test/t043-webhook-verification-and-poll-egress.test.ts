// T-043 — Restart-safe external reconciliation (unit layer: the trust boundary). Fulfillment webhook signatures are
// HMAC-SHA256 over `<timestamp>.<raw body bytes>` compared in constant time against the candidate revision verifiers,
// with a bounded timestamp window and strict header/body schemas (no URL, tenant or other out-of-schema field).
// Polling targets come only from the pinned revision: the HTTPS status adapter refuses an endpoint policy whose digest
// is not the pinned revision's, builds paths only from validated identifiers, goes through M07's SSRF-guarded
// transport (no private/metadata addresses, no redirects) and is UNSUPPORTED without a separately provisioned status
// credential: it never resolves the paid revision's credential reference.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HttpsProviderTransport,
  ProviderEgressError,
  endpointPolicyDigest,
  type EndpointPolicy,
  type ProviderHttpRequest,
  type ProviderHttpTransport,
  type TransportCallOptions,
} from '@uptimebuyer/providers';
import {
  FULFILLMENT_WEBHOOK_LIMITS,
  HttpsFulfillmentStatusAdapter,
  parseFulfillmentEvent,
  signFulfillmentWebhook,
  verifyFulfillmentSignature,
  type FulfillmentTarget,
} from '../src/index.js';

const key = new Uint8Array(32).fill(3);
const other = new Uint8Array(32).fill(4);
const body = new Uint8Array(
  Buffer.from(
    JSON.stringify({
      eventId: 'evt-1',
      type: 'purchase_order.status',
      clientOperationId: 'op_11111111-2222-3333-4444-555555555555',
      status: 'shipped',
      observedAt: '2026-11-05T10:00:00.000Z',
    }),
  ),
);
const now = 1_800_000_000;
const candidates = [
  { revisionId: 'par_old-0001', key: other },
  { revisionId: 'par_cur-0001', key },
];

describe('T-043 fulfillment webhook verification', () => {
  it('verifies the exact raw bytes and reports which pinned revision verified it', () => {
    const sig = signFulfillmentWebhook(key, now, body);
    expect(verifyFulfillmentSignature(sig, body, now, candidates)).toEqual({
      ok: true,
      revisionId: 'par_cur-0001',
      timestamp: now,
    });
    const tampered = new Uint8Array(body);
    tampered[10] = tampered[10]! ^ 1;
    expect(verifyFulfillmentSignature(sig, tampered, now, candidates)).toMatchObject({
      ok: false,
      reasonCode: 'SIGNATURE_INVALID',
    });
  });

  it('enforces the timestamp window in both directions and the signature header format', () => {
    const t = FULFILLMENT_WEBHOOK_LIMITS.toleranceSeconds;
    for (const ts of [now - t - 1, now + t + 1])
      expect(verifyFulfillmentSignature(signFulfillmentWebhook(key, ts, body), body, now, candidates)).toMatchObject({
        ok: false,
        reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE',
      });
    for (const bad of [
      '',
      'v1=abc',
      `t=${now},v1=${'g'.repeat(64)}`,
      `t=${now},v1=${'a'.repeat(63)}`,
      `t=${now};v1=${'a'.repeat(64)}`,
    ])
      expect(verifyFulfillmentSignature(bad, body, now, candidates)).toMatchObject({ ok: false });
    // Short verifier keys are never used.
    const weak = [{ revisionId: 'par_weak-0001', key: new Uint8Array(8).fill(1) }];
    expect(verifyFulfillmentSignature(signFulfillmentWebhook(weak[0]!.key, now, body), body, now, weak)).toMatchObject({
      ok: false,
    });
  });

  it('compares MACs in constant time (timingSafeEqual over equal-length buffers only)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'webhooks.ts'), 'utf8');
    expect(src).toMatch(/timingSafeEqual\(/);
    expect(src).not.toMatch(/expected\s*===\s*given|given\s*===\s*expected|\.toString\('hex'\)\s*===/);
  });

  it('the body schema is strict: no URL, tenant, revision or unknown field; bounded identifiers', () => {
    const base = JSON.parse(Buffer.from(body).toString('utf8'));
    expect(parseFulfillmentEvent(body).ok).toBe(true);
    for (const extra of [
      { callbackUrl: 'https://169.254.169.254/' },
      { pollUrl: 'https://evil.example/' },
      { tenantId: 'ten_abcd' },
      { providerAccountRevisionId: 'par_abcd' },
    ])
      expect(parseFulfillmentEvent(new Uint8Array(Buffer.from(JSON.stringify({ ...base, ...extra })))).ok).toBe(false);
    expect(
      parseFulfillmentEvent(new Uint8Array(Buffer.from(JSON.stringify({ ...base, eventId: 'x'.repeat(200) })))).ok,
    ).toBe(false);
    expect(parseFulfillmentEvent(new Uint8Array(Buffer.from('{not json')))).toEqual({ ok: false });
    expect(FULFILLMENT_WEBHOOK_LIMITS.maxBodyBytes).toBeLessThanOrEqual(65_536);
  });
});

const policy: EndpointPolicy = {
  schema: 'provider-endpoint-policy.v1',
  origins: ['https://orders.coldline-merchant.example'],
};
const target = (over: Partial<FulfillmentTarget> = {}): FulfillmentTarget => ({
  orderKind: 'PURCHASE_ORDER',
  orderId: 'pur_0000-1111',
  clientOperationId: 'op_11111111-2222-3333-4444-555555555555',
  providerRef: 'rec_abc123',
  revision: {
    providerAccountId: 'pac_0000-1111',
    providerAccountRevisionId: 'par_0000-1111',
    providerKey: 'coldline-orders',
    environment: 'SANDBOX',
    capabilities: ['PURCHASE', 'WEBHOOK'],
    endpointPolicyDigest: endpointPolicyDigest(policy),
  },
  ...over,
});

class CapturingTransport implements ProviderHttpTransport {
  readonly adapterClass = 'RECORDED' as never;
  requests: ProviderHttpRequest[] = [];
  async request(req: ProviderHttpRequest, opts: TransportCallOptions) {
    this.requests.push(req);
    opts.onSent();
    return {
      status: 200,
      body: { observations: [{ eventId: 'p1', status: 'shipped', observedAt: '2026-11-05T10:00:00.000Z' }] },
    };
  }
}

describe('T-043 polling targets come only from the pinned revision (SSRF)', () => {
  const statusCredential = async () => new Uint8Array(32).fill(5);

  it('without a separately provisioned status credential polling is UNSUPPORTED (the paid credential is never used)', () => {
    const a = new HttpsFulfillmentStatusAdapter({
      providerKey: 'coldline-orders',
      policy,
      transport: new CapturingTransport(),
    });
    expect(a.assess(target().revision)).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'STATUS_CREDENTIAL_NOT_PROVISIONED',
    });
  });

  it('refuses an endpoint policy that is not bound to the pinned revision', async () => {
    const a = new HttpsFulfillmentStatusAdapter({
      providerKey: 'coldline-orders',
      policy: { schema: 'provider-endpoint-policy.v1', origins: ['https://elsewhere.example'] },
      transport: new CapturingTransport(),
      statusCredential,
    });
    expect(a.assess(target().revision)).toEqual({
      kind: 'UNSUPPORTED',
      reasonCode: 'ENDPOINT_POLICY_NOT_BOUND_TO_REVISION',
    });
    await expect(a.lookup(target(), { signal: AbortSignal.timeout(1000) })).rejects.toThrow(ProviderEgressError);
  });

  it('builds paths only from validated identifiers; traversal-shaped references are refused before egress', async () => {
    const t = new CapturingTransport();
    const a = new HttpsFulfillmentStatusAdapter({
      providerKey: 'coldline-orders',
      policy,
      transport: t,
      statusCredential,
    });
    const ok = await a.lookup(target(), { signal: AbortSignal.timeout(1000) });
    expect(ok.status).toBe('FOUND');
    expect(t.requests[0]!.path).toBe('/v1/orders/rec_abc123/status');
    await a.lookup(target({ providerRef: null }), { signal: AbortSignal.timeout(1000) });
    expect(t.requests[1]!.path).toBe('/v1/orders/status');
    expect(t.requests[1]!.query).toEqual({ client_operation_id: 'op_11111111-2222-3333-4444-555555555555' });
    for (const providerRef of ['../admin', 'a/b', 'a%2fb', 'http://169.254.169.254', 'x y'])
      await expect(a.lookup(target({ providerRef }), { signal: AbortSignal.timeout(1000) })).rejects.toThrow(
        ProviderEgressError,
      );
    expect(t.requests).toHaveLength(2);
  });

  it('through the M07 HTTPS transport a private or metadata resolution is refused before any request', async () => {
    let requested = 0;
    const transport = new HttpsProviderTransport(
      policy,
      async () => ['169.254.169.254'],
      async () => {
        requested++;
        throw new Error('must not be reached');
      },
    );
    const a = new HttpsFulfillmentStatusAdapter({
      providerKey: 'coldline-orders',
      policy,
      transport,
      statusCredential,
    });
    await expect(a.lookup(target(), { signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({
      reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED',
    });
    expect(requested).toBe(0);
  });
});
