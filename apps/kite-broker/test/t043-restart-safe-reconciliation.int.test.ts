// T-043 — Restart-safe external reconciliation (NFR-02, NFR-03, INV-08, INV-12). Verified webhooks and bounded polling
// resolve the exact provider-account revision pinned to the order's attempt, namespace event identity by tenant and
// provider account, and converge across worker restart and account rotation without cross-tenant or cross-revision
// mapping, state regression, duplicate side effect or lost raw evidence. UNKNOWN orders reconcile through M09's broker
// reconcile path by the pre-egress client operation key (no provider reference needed); without lookup or same-key
// replay they stay UNKNOWN for manual review with no autonomous retry, and a "not found" lookup is never no-effect.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseOrderStateChangedEventSchema, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import { OutboxPublisher, appendProviderAccountRevision } from '@uptimebuyer/data';
import { endpointPolicyDigest } from '@uptimebuyer/providers';
import {
  FULFILLMENT_WEBHOOK_LIMITS,
  FulfillmentAdapterRegistry,
  RecordedFulfillmentAdapter,
  dispatchOrder,
  handleCommercialIntentEvent,
  handleOrderStateEvent,
  ingestFulfillmentWebhook,
  pollFulfillmentStatus,
  reconcileOrder,
  runFulfillmentObservationJobs,
} from '@uptimebuyer/orders';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { conservation, inProcessBroker, intentRef, rowOf } from './helpers.js';
import {
  MERCHANT_POLICY,
  brokerDeps,
  createOrdersWorld,
  eventBody,
  incidentState,
  orderFor,
  paidFulfillmentAccount,
  view,
  webhook,
  type OrdersWorld,
} from './m10-helpers.js';

let w: OrdersWorld;
beforeAll(async () => {
  w = await createOrdersWorld('t043');
});
afterAll(async () => w?.close());

const FAR = () => new Date(Date.now() + 3_600_000).toISOString();
const ingest = (req: ReturnType<typeof webhook>, nowSeconds?: () => number) =>
  ingestFulfillmentWebhook(w.db.pool, req, { credentials: w.creds, ...(nowSeconds ? { nowSeconds } : {}) });
const apply = () => runFulfillmentObservationJobs(w.db.pool, { workerId: 'm10-apply' });

async function sentOrder(kind: 'PART_PURCHASE' | 'SERVICE_JOB' = 'PART_PURCHASE') {
  const o = await orderFor(w, kind);
  const sent = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
  return { ...o, sent };
}

describe('T-043 verified webhooks bound to the pinned revision', () => {
  it('a verified webhook advances the order, keeps the raw body bytes and is idempotent on replay', async () => {
    const { orderId, sent } = await sentOrder();
    expect([sent.state, sent.economic.state]).toEqual(['ACCEPTED', 'CONFIRMED']);
    const body = eventBody(sent, 'ordered', { providerRef: sent.providerRef });
    const req = webhook(w.account.binding, w.account.verifierKey, body);
    expect((await ingest(req)).status).toBe('ACCEPTED');
    expect((await apply()).applied).toBe(1);
    const v = await view(w, orderId);
    expect(v.state).toBe('ORDERED');
    const obs = v.observations.find((o) => o.source === 'WEBHOOK')!;
    expect(obs.providerAccountRevisionId).toBe(w.account.revisionId);
    const raw = (await rowOf(w, 'fulfillment_observations', obs.observationId)).raw_body as Buffer;
    expect(Buffer.compare(raw, Buffer.from(req.rawBody))).toBe(0);
    // Replay of the same provider event: DUPLICATE, no second observation or transition.
    expect((await ingest(req)).status).toBe('DUPLICATE');
    await apply();
    const again = await view(w, orderId);
    expect([again.version, again.transitions.length, again.observations.length]).toEqual([
      v.version,
      v.transitions.length,
      v.observations.length,
    ]);
  });

  it('forged, expired, oversized, malformed and unknown-binding webhooks are rejected before any effect', async () => {
    const { orderId, sent } = await sentOrder();
    const body = eventBody(sent, 'shipped');
    const wrongKey = new Uint8Array(32).fill(7);
    expect(await ingest(webhook(w.account.binding, wrongKey, body))).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'SIGNATURE_INVALID',
    });
    const old = Math.floor(Date.now() / 1000) - FULFILLMENT_WEBHOOK_LIMITS.toleranceSeconds - 5;
    expect(await ingest(webhook(w.account.binding, w.account.verifierKey, body, { ts: old }))).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE',
    });
    const future = Math.floor(Date.now() / 1000) + FULFILLMENT_WEBHOOK_LIMITS.toleranceSeconds + 5;
    expect((await ingest(webhook(w.account.binding, w.account.verifierKey, body, { ts: future }))).status).toBe(
      'REJECTED',
    );
    const big = new Uint8Array(FULFILLMENT_WEBHOOK_LIMITS.maxBodyBytes + 1).fill(32);
    expect(await ingest(webhook(w.account.binding, w.account.verifierKey, {}, { raw: big }))).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'PAYLOAD_TOO_LARGE',
    });
    // A body may not carry a callback URL, tenant or any field outside the strict schema (no SSRF/IDOR lever).
    for (const extra of [{ callbackUrl: 'https://169.254.169.254/latest' }, { tenantId: w.tenant.tenantId }])
      expect(await ingest(webhook(w.account.binding, w.account.verifierKey, { ...body, ...extra }))).toMatchObject({
        status: 'REJECTED',
        reasonCode: 'PAYLOAD_SCHEMA_INVALID',
      });
    expect((await ingest(webhook('x'.repeat(43), w.account.verifierKey, body))).status).toBe('REJECTED');
    await apply();
    expect((await view(w, orderId)).state).toBe('ACCEPTED');
  });

  it('cross-tenant and cross-kind callbacks are quarantined and never touch the order', async () => {
    const { orderId, sent } = await sentOrder();
    const beta = await seedTenant(w.db.pool, w.idp, 't043-beta');
    const foreign = await paidFulfillmentAccount(w, beta.admin, 't043-beta');
    // Tenant B's genuine binding and key naming tenant A's client operation id.
    expect(await ingest(webhook(foreign.binding, foreign.verifierKey, eventBody(sent, 'shipped')))).toMatchObject({
      status: 'QUARANTINED',
      reasonCode: 'TARGET_NOT_FOUND',
    });
    // A service-job event naming a purchase order's operation id does not resolve (separate kinds).
    const crossKind = { ...eventBody(sent, 'scheduled'), type: 'service_job.status' };
    expect(await ingest(webhook(w.account.binding, w.account.verifierKey, crossKind))).toMatchObject({
      status: 'QUARANTINED',
      reasonCode: 'TARGET_NOT_FOUND',
    });
    // A purchase event with a raw word of the other kind is recorded UNMAPPED and changes nothing.
    expect((await ingest(webhook(w.account.binding, w.account.verifierKey, eventBody(sent, 'scheduled')))).status).toBe(
      'ACCEPTED',
    );
    await apply();
    const v = await view(w, orderId);
    expect(v.state).toBe('ACCEPTED');
    expect(v.observations.some((o) => o.disposition === 'UNMAPPED')).toBe(true);
  });

  it('regression and out-of-order delivery are recorded as evidence but never applied', async () => {
    const { orderId, sent } = await sentOrder();
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    for (const [status, ms] of [
      ['ordered', 1_000],
      ['shipped', 3_000],
      ['ordered', 4_000], // regression SHIPPED -> ORDERED: illegal
      ['partially_filled', 2_000], // legal edge from SHIPPED but older than the applied shipment: stale
    ] as const)
      await ingest(webhook(w.account.binding, w.account.verifierKey, eventBody(sent, status, { observedAt: at(ms) })));
    await apply();
    const v = await view(w, orderId);
    expect(v.state).toBe('SHIPPED');
    expect(v.observations.map((o) => o.disposition).filter((d) => d !== 'APPLIED')).toEqual(
      expect.arrayContaining(['ILLEGAL', 'STALE']),
    );
    expect(v.transitions.map((t) => t.to)).toEqual(['ACCEPTED', 'ORDERED', 'SHIPPED']);
  });

  it('account rotation: the old order keeps reconciling on its pinned revision; the new verifier cannot retarget it', async () => {
    // A dedicated account so the rest of the suite keeps ordering against the shared one.
    const acct = await paidFulfillmentAccount(w, w.admin, 't043-rot');
    (w as { providerAccountRevisionId: string }).providerAccountRevisionId = acct.revisionId;
    let orderId: string;
    let sent: Awaited<ReturnType<typeof sentOrder>>['sent'];
    try {
      ({ orderId, sent } = await sentOrder());
    } finally {
      (w as { providerAccountRevisionId: string }).providerAccountRevisionId = w.account.revisionId;
    }
    const newKey = new Uint8Array(32).fill(9);
    const newVerifier = `secretref:webhook/tenants/${w.tenant.tenantId}/t043-rot-orders-verifier-r2`;
    w.creds.set(newVerifier, newKey);
    const rotated = await appendProviderAccountRevision(w.db.pool, w.admin, acct.providerAccountId as never, {
      revision: {
        capabilities: ['PURCHASE', 'SERVICE_BOOKING', 'WEBHOOK'],
        paid: true,
        ownerService: 'KITE_BROKER_PAID',
        credentialRef: `secretref:provider/tenants/${w.tenant.tenantId}/t043-rot-orders-paid-r2`,
        endpointPolicyDigest: endpointPolicyDigest(MERCHANT_POLICY),
        webhookVerifierRef: newVerifier,
      },
      source: 'API',
    });
    expect(rotated.providerAccountRevisionId).not.toBe(acct.revisionId);
    // Signed with the NEW revision's verifier for an order pinned to the OLD revision: stale-revision retargeting.
    expect(await ingest(webhook(acct.binding, newKey, eventBody(sent, 'shipped')))).toMatchObject({
      status: 'QUARANTINED',
      reasonCode: 'REVISION_MISMATCH',
    });
    // Signed with the pinned (superseded) revision's verifier inside its window: applied.
    expect((await ingest(webhook(acct.binding, acct.verifierKey, eventBody(sent, 'ordered')))).status).toBe('ACCEPTED');
    await apply();
    expect((await view(w, orderId)).state).toBe('ORDERED');
    // Polling resolves the order's pinned revision, never the account's current one.
    const poller = new RecordedFulfillmentAdapter({ providerKey: 't043-rot-orders' });
    poller.script(sent.clientOperationId, [
      { eventId: 'p-1', rawStatus: 'shipped', observedAt: new Date(Date.now() + 5_000).toISOString() },
    ]);
    await pollFulfillmentStatus(
      w.db.pool,
      w.service,
      { adapters: new FulfillmentAdapterRegistry([poller]) },
      { dueBefore: FAR() },
    );
    expect(poller.targets.map((t) => t.revision.providerAccountRevisionId)).toContain(acct.revisionId);
    expect(poller.targets.map((t) => t.revision.providerAccountRevisionId)).not.toContain(
      rotated.providerAccountRevisionId,
    );
    expect((await view(w, orderId)).state).toBe('SHIPPED');
  });
});

describe('T-043 bounded polling converges across restart and concurrent workers', () => {
  it('concurrent pollers and a restarted worker apply each provider event exactly once', async () => {
    const { orderId, sent } = await sentOrder('SERVICE_JOB');
    const poller = new RecordedFulfillmentAdapter({ providerKey: 't043-orders' });
    const base = Date.now();
    poller.script(sent.clientOperationId, [
      { eventId: 's-1', rawStatus: 'scheduled', observedAt: new Date(base + 1_000).toISOString() },
      { eventId: 's-2', rawStatus: 'en_route', observedAt: new Date(base + 2_000).toISOString() },
    ]);
    const reg = new FulfillmentAdapterRegistry([poller]);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg }, { dueBefore: FAR() }),
      ),
    );
    let v = await view(w, orderId);
    expect(v.state).toBe('EN_ROUTE');
    // Restart: a fresh pool, the provider has advanced; earlier events are re-reported and deduplicated.
    poller.script(sent.clientOperationId, [
      { eventId: 's-1', rawStatus: 'scheduled', observedAt: new Date(base + 1_000).toISOString() },
      { eventId: 's-2', rawStatus: 'en_route', observedAt: new Date(base + 2_000).toISOString() },
      { eventId: 's-3', rawStatus: 'arrived', observedAt: new Date(base + 3_000).toISOString() },
    ]);
    const restarted = new pg.Pool({ connectionString: w.db.url, max: 4 });
    try {
      await pollFulfillmentStatus(restarted, w.service, { adapters: reg }, { dueBefore: FAR() });
    } finally {
      await restarted.end();
    }
    v = await view(w, orderId);
    expect(v.state).toBe('ARRIVED');
    expect(v.transitions.map((t) => t.to)).toEqual(['ACCEPTED', 'SCHEDULED', 'EN_ROUTE', 'ARRIVED']);
    const keys = v.observations.filter((o) => o.source === 'POLL').map((o) => o.providerEventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(w.adapter.executeCalls).toBeGreaterThan(0);
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('polling is bounded: terminal orders are not polled and a poll budget is enforced', async () => {
    const { orderId, sent } = await sentOrder();
    const poller = new RecordedFulfillmentAdapter({ providerKey: 't043-orders' });
    poller.script(sent.clientOperationId, [
      { eventId: 'c-1', rawStatus: 'cancelled', observedAt: new Date(Date.now() + 1_000).toISOString() },
    ]);
    const reg = new FulfillmentAdapterRegistry([poller]);
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg }, { dueBefore: FAR() });
    expect((await view(w, orderId)).state).toBe('CANCELLED');
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg }, { dueBefore: FAR() });
    expect(poller.targets.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect((await rowOf(w, 'purchase_orders', orderId)).next_poll_at).toBeNull();
  });
});

describe('T-043 UNKNOWN reconciles by the pre-egress operation key through the M09 broker', () => {
  it('a lost response leaves the order UNKNOWN; reconcile converges by client operation key with one charge', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    w.adapter.nextModes.push('DROP_RESPONSE');
    const calls = w.adapter.executeCalls;
    const unknown = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    expect([unknown.state, unknown.economic.state, unknown.providerRef]).toEqual(['UNKNOWN', 'UNKNOWN', null]);
    expect(unknown.economic.reconciliation).toBe('SCHEDULED');
    // Dispatch again never re-sends a started intent.
    await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    const done = await reconcileOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    expect([done.state, done.economic.state]).toEqual(['ACCEPTED', 'CONFIRMED']);
    expect(done.clientOperationId).toBe(unknown.clientOperationId);
    expect(w.adapter.executeCalls).toBe(calls + 1);
    expect(done.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['REQUESTED>UNKNOWN', 'UNKNOWN>ACCEPTED']);
    expect(done.transitions.at(-1)!.source).toBe('BROKER');
  });

  it('without authoritative lookup or same-key replay the order stays UNKNOWN for manual review, never retried', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    w.adapter.nextModes.push('DROP_RESPONSE');
    const calls = w.adapter.executeCalls;
    expect((await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w))).state).toBe('UNKNOWN');
    // Reconciliation capability turns out to be absent after possible egress (a broker whose adapter cannot look up).
    const incapable = new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: false });
    const deps = brokerDeps(w, inProcessBroker(w, incapable));
    for (let i = 0; i < 3; i++) {
      await reconcileOrder(w.db.pool, w.operator, o.orderId, deps);
      await dispatchOrder(w.db.pool, w.operator, o.orderId, deps);
    }
    const after = await view(w, o.orderId);
    expect([after.state, after.economic.state, after.economic.adapterCapability]).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNSUPPORTED',
    ]);
    expect(after.economic.reconciliation).toBe('MANUAL_REVIEW');
    expect([w.adapter.executeCalls, incapable.executeCalls]).toEqual([calls + 1, 0]);
    expect(after.noEffectProven).toBe(false);
    expect((await rowOf(w, 'commercial_intents', after.commercialIntentId)).open_reserved_minor).not.toBe('0');
  });

  it('a fulfillment "not found" for an UNKNOWN order is never proof of no effect', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    w.adapter.nextModes.push('DROP_RESPONSE');
    await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    const poller = new RecordedFulfillmentAdapter({ providerKey: 't043-orders' });
    const reg = new FulfillmentAdapterRegistry([poller]);
    await pollFulfillmentStatus(w.db.pool, w.service, { adapters: reg }, { dueBefore: FAR() });
    const v = await view(w, o.orderId);
    expect([v.state, v.noEffectProven]).toEqual(['UNKNOWN', false]);
    expect(v.observations.some((x) => x.disposition === 'NOT_FOUND')).toBe(true);
    expect(poller.targets.find((t) => t.orderId === o.orderId)!.providerRef).toBeNull();
  });

  it('a fulfillment cancellation never rewrites payment state or moves money', async () => {
    const { orderId, sent } = await sentOrder();
    const ledger = async () =>
      (
        await w.db.pool.query(
          `SELECT count(*)::int AS n FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2`,
          [w.tenant.tenantId, sent.commercialIntentId],
        )
      ).rows[0].n;
    const before = await ledger();
    await ingest(webhook(w.account.binding, w.account.verifierKey, eventBody(sent, 'cancelled')));
    await apply();
    const v = await view(w, orderId);
    expect([v.state, v.economic.state]).toEqual(['CANCELLED', 'CONFIRMED']);
    expect(await ledger()).toBe(before);
    expect(v.noEffectProven).toBe(false);
  });
});

describe('T-043 order/job facts on the outbox are replay-safe for downstream consumers (M11 CMMS input)', () => {
  it('the broker result alone drives the order and incident through the outbox; redelivery is a no-op', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    // The broker executes without any M10 call; only its commercial_intent.state_changed.v1 events reach M10.
    await w.broker.execute(intentRef(w, o.out.order.commercialIntentId));
    const delivered: DomainEventEnvelope[] = [];
    const publisher = new OutboxPublisher(
      w.db.pool,
      {
        async publish(e) {
          delivered.push(e);
          await handleCommercialIntentEvent(w.db.pool, e);
          await handleOrderStateEvent(w.db.pool, e);
        },
      },
      { workerId: 't043-outbox' },
    );
    while ((await publisher.runOnce()).claimed > 0);
    const v = await view(w, o.orderId);
    expect([v.state, v.economic.state]).toEqual(['ACCEPTED', 'CONFIRMED']);
    expect(await incidentState(w, o.action.incidentId)).toBe('EXECUTING');
    // Order facts: strict contract payloads with strictly increasing aggregate versions.
    const facts = delivered.filter((e) => e.aggregateId === o.orderId);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) PurchaseOrderStateChangedEventSchema.parse(f);
    const versions = facts.map((f) => f.aggregateVersion);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    // Redelivery (at-least-once) of every event changes nothing.
    const before = await view(w, o.orderId);
    for (const e of delivered) {
      expect(['DUPLICATE', 'IGNORED']).toContain(await handleCommercialIntentEvent(w.db.pool, e));
      expect(['DUPLICATE', 'IGNORED']).toContain(await handleOrderStateEvent(w.db.pool, e));
    }
    const after = await view(w, o.orderId);
    expect([after.version, after.transitions.length]).toEqual([before.version, before.transitions.length]);
  });
});
