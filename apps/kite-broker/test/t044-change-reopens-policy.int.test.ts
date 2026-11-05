// T-044 — Cancellation or substitution reopens policy (FR-13, INV-03, INV-14). Partial fill, provider substitute,
// stock/quantity/price/ETA change, cancellation and provider failure (purchase) and reschedule, no-show, scope change
// and provider failure (service) each enter their explicit state, block fulfillment/installation, invalidate the
// executing plan (in-flight reconciliation kept) and its unexecuted approvals, escalate the incident through M04, and
// record a never-auto-accepted change proposal; any changed candidate goes through evidence/compatibility/approval
// again as a NEW action lineage while the prior order/job lineage is not mutated. The egress linearization point:
// revocation before it prevents the send; after it, the in-flight effect is preserved and reconciled, never erased or
// duplicated. Completion (delivery, verified work) moves the incident only to VERIFYING and the plan to COMPLETED; it
// never reaches RECOVERED or moves money.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@uptimebuyer/contracts';
import { evaluateCandidate } from '@uptimebuyer/compatibility';
import { createRecoveryPlan } from '@uptimebuyer/planning';
import {
  FulfillmentAdapterRegistry,
  RecordedFulfillmentAdapter,
  dispatchOrder,
  getFulfillmentGate,
  ingestFulfillmentWebhook,
  pollFulfillmentStatus,
  reconcileOrder,
  recordFulfillmentVerification,
  revokeOrder,
  runFulfillmentObservationJobs,
  syncIncidentForOrder,
} from '@uptimebuyer/orders';
import { exactCandidate } from '../../../packages/compatibility/test/helpers.js';
import { attemptOf, rejection, rowOf } from './helpers.js';
import {
  brokerDeps,
  createOrdersWorld,
  eventBody,
  incidentState,
  orderFor,
  view,
  webhook,
  type OrdersWorld,
} from './m10-helpers.js';

let w: OrdersWorld;
beforeAll(async () => {
  w = await createOrdersWorld('t044');
});
afterAll(async () => w?.close());

const FAR = () => new Date(Date.now() + 3_600_000).toISOString();

async function sentOrder(kind: 'PART_PURCHASE' | 'SERVICE_JOB') {
  const o = await orderFor(w, kind);
  const sent = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
  await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
  expect(await incidentState(w, o.action.incidentId)).toBe('EXECUTING');
  expect((await rowOf(w, 'recovery_plans', o.action.planId)).state).toBe('EXECUTING');
  return { ...o, sent };
}

/** Deliver a status script (webhooks, in order) and apply it. */
async function report(orderView: Awaited<ReturnType<typeof view>>, steps: [string, Record<string, unknown>?][]) {
  for (const [status, extra] of steps) {
    const r = await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(w.account.binding, w.account.verifierKey, eventBody(orderView, status, extra ?? {})),
      { credentials: w.creds },
    );
    expect(r.status).toBe('ACCEPTED');
  }
  await runFulfillmentObservationJobs(w.db.pool, { workerId: 'm10-t044' });
}

async function expectReopened(
  o: Awaited<ReturnType<typeof sentOrder>>,
  expected: { state: string; changeKind: string },
) {
  const v = await view(w, o.orderId);
  expect(v.state).toBe(expected.state);
  expect(v.blockedReason).not.toBeNull();
  const change = v.changes.find((c) => c.changeKind === expected.changeKind);
  expect(change, expected.changeKind).toBeDefined();
  expect(change!.autoAccepted).toBe(false);
  expect(change!.requiresReentry.length).toBeGreaterThan(0);
  // The executing plan is invalidated with in-flight reconciliation; its approvals can no longer reserve.
  const plan = await rowOf(w, 'recovery_plans', o.action.planId);
  expect([plan.state, plan.in_flight_reconciliation]).toEqual(['INVALIDATED', true]);
  const ev = await w.db.pool.query(`SELECT event_type FROM approval_events WHERE tenant_id = $1 AND approval_id = $2`, [
    w.tenant.tenantId,
    o.action.approvalId,
  ]);
  expect(ev.rows.map((r) => r.event_type)).toEqual(['INVALIDATED']);
  // M04 moves the incident to ESCALATED after possible egress; nothing reaches RECOVERED.
  await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
  expect(await incidentState(w, o.action.incidentId)).toBe('ESCALATED');
  // Installation / next action is blocked: verification and the fulfillment gate refuse.
  const gate = await getFulfillmentGate(w.db.pool, w.viewerCtx, o.orderId);
  expect([gate.installable, gate.provesRecovery]).toEqual([false, false]);
  // The prior lineage is not mutated: same intent, one attempt, the payment effect still reconciling/confirmed.
  expect([v.commercialIntentId, v.actionDigest]).toEqual([o.sent.commercialIntentId, o.sent.actionDigest]);
  expect((await attemptOf(w, v.commercialIntentId)).client_operation_id).toBe(o.sent.clientOperationId);
  expect((await rowOf(w, 'commercial_intents', v.commercialIntentId)).state).toBe('CONFIRMED');
  return v;
}

describe('T-044 purchase-order changes enter explicit states and reopen policy', () => {
  it('partial fill', async () => {
    const o = await sentOrder('PART_PURCHASE');
    await report(o.sent, [['ordered'], ['partially_filled', { details: { quantityFilled: 0 } }]]);
    await expectReopened(o, { state: 'PARTIALLY_FILLED', changeKind: 'PARTIAL_FILL' });
  });

  it('provider substitute is never auto-accepted and the substitute candidate fails closed in compatibility', async () => {
    const o = await sentOrder('PART_PURCHASE');
    await report(o.sent, [
      ['substitution_proposed', { details: { substitutePartNumber: '5A1-0499', substituteManufacturer: 'Northwind' } }],
    ]);
    const v = await expectReopened(o, { state: 'SUBSTITUTION_PROPOSED', changeKind: 'SUBSTITUTION' });
    const proposal = v.changes.find((c) => c.changeKind === 'SUBSTITUTION')!;
    expect(proposal.requiresReentry).toEqual(['EVIDENCE', 'COMPATIBILITY', 'APPROVAL']);
    // Verification of the substituted fulfillment is refused: it is not the approved action.
    const r = await rejection(
      recordFulfillmentVerification(w.db.pool, w.operator, {
        orderId: o.orderId,
        outcome: 'VERIFIED',
        idempotencyKey: w.key('verify'),
      }),
    );
    expect(r.reasonCode).toMatch(/^(FULFILLMENT_BLOCKED|STATE_TRANSITION_INVALID)$/);
    // The changed candidate re-enters M06 as a new candidate: the substitute part is not an exact match -> not ALLOW.
    const inc = {
      incidentId: o.action.incidentId as never,
      evidenceRevisionId: (await rowOf(w, 'candidate_actions', o.action.candidateActionId)).evidence_revision_id,
    };
    const sub = await exactCandidate(w, inc, {
      partNumber: String(proposal.proposed.substitutePartNumber),
      merchantId: 'mer_coldline-sub1',
    });
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: sub.candidateActionId }, w.signing);
    expect(d.decision).not.toBe('ALLOW');
    // The old order is untouched by the new candidate.
    expect((await view(w, o.orderId)).version).toBe(v.version);
  });

  for (const [raw, changeKind] of [
    ['backordered', 'STOCK_CHANGE'],
    ['quantity_changed', 'QUANTITY_CHANGE'],
    ['eta_changed', 'ETA_CHANGE'],
  ] as const)
    it(`material ${changeKind.toLowerCase().replace('_', ' ')} enters CHANGE_REVIEW`, async () => {
      const o = await sentOrder('PART_PURCHASE');
      await report(o.sent, [['ordered'], [raw]]);
      await expectReopened(o, { state: 'CHANGE_REVIEW', changeKind });
    });

  it('a price change re-enters compatibility and approval as a NEW action lineage; the old order stays', async () => {
    const o = await sentOrder('PART_PURCHASE');
    await report(o.sent, [['ordered', { details: { totalMinor: '21000', currency: 'USD' } }]]);
    const v = await expectReopened(o, { state: 'CHANGE_REVIEW', changeKind: 'PRICE_CHANGE' });
    const change = v.changes.find((c) => c.changeKind === 'PRICE_CHANGE')!;
    expect(change.proposed.totalMinor).toBe('21000');
    // Re-register at the new price: new digest, its own compatibility decision, its own plan; nothing is reused.
    const cand = await rowOf(w, 'candidate_actions', o.action.candidateActionId);
    const repriced = await exactCandidate(
      w,
      { incidentId: o.action.incidentId as never, evidenceRevisionId: cand.evidence_revision_id },
      { amount: money(21_000n, 'USD'), merchantId: cand.merchant_id },
    );
    expect(repriced.actionDigest).not.toBe(v.actionDigest);
    const d = await evaluateCandidate(
      w.db.pool,
      w.service,
      { candidateActionId: repriced.candidateActionId },
      w.signing,
    );
    expect(d.decision).toBe('ALLOW');
    // The invalidated plan no longer blocks re-planning (APPROVED/EXECUTING plans would).
    await expect(
      createRecoveryPlan(
        w.db.pool,
        w.service,
        {
          incidentId: o.action.incidentId,
          candidates: [{ candidateActionId: repriced.candidateActionId, quoteId: null }],
        },
        w.signing,
      ),
    ).resolves.toBeTruthy();
    const old = await view(w, o.orderId);
    expect([old.state, old.version, old.actionDigest]).toEqual([v.state, v.version, v.actionDigest]);
  });

  it('cancellation and provider failure', async () => {
    const c = await sentOrder('PART_PURCHASE');
    await report(c.sent, [['ordered'], ['cancelled']]);
    await expectReopened(c, { state: 'CANCELLED', changeKind: 'CANCELLATION' });
    const f = await sentOrder('PART_PURCHASE');
    await report(f.sent, [['ordered'], ['shipped'], ['failed']]);
    await expectReopened(f, { state: 'FAILED', changeKind: 'PROVIDER_FAILURE' });
  });
});

describe('T-044 service-job changes enter explicit states and reopen policy', () => {
  it('reschedule', async () => {
    const o = await sentOrder('SERVICE_JOB');
    await report(o.sent, [['scheduled'], ['rescheduled']]);
    await expectReopened(o, { state: 'RESCHEDULED', changeKind: 'RESCHEDULE' });
  });

  it('no-show', async () => {
    const o = await sentOrder('SERVICE_JOB');
    await report(o.sent, [['scheduled'], ['en_route'], ['no_show']]);
    await expectReopened(o, { state: 'NO_SHOW', changeKind: 'NO_SHOW' });
  });

  it('service-scope change', async () => {
    const o = await sentOrder('SERVICE_JOB');
    await report(o.sent, [
      ['scheduled'],
      ['en_route'],
      ['arrived'],
      ['scope_change_proposed', { details: { totalMinor: '40000', currency: 'USD' } }],
    ]);
    await expectReopened(o, { state: 'SCOPE_CHANGE_PROPOSED', changeKind: 'SCOPE_CHANGE' });
  });

  it('provider failure (polled)', async () => {
    const o = await sentOrder('SERVICE_JOB');
    const poller = new RecordedFulfillmentAdapter({ providerKey: 't044-orders' });
    poller.script(o.sent.clientOperationId, [
      { eventId: 'f-1', rawStatus: 'scheduled', observedAt: new Date(Date.now() + 1_000).toISOString() },
      { eventId: 'f-2', rawStatus: 'failed', observedAt: new Date(Date.now() + 2_000).toISOString() },
    ]);
    await pollFulfillmentStatus(
      w.db.pool,
      w.service,
      { adapters: new FulfillmentAdapterRegistry([poller]) },
      { dueBefore: FAR() },
    );
    await expectReopened(o, { state: 'FAILED', changeKind: 'PROVIDER_FAILURE' });
  });
});

describe('T-044 egress linearization point', () => {
  it('revocation before linearization prevents the send; the incident returns to planning (no possible egress)', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    const calls = w.adapter.executeCalls;
    await revokeOrder(w.db.pool, w.approver, { orderId: o.orderId, reasonCode: 'OPERATOR_CANCELLED' });
    const v = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    expect(w.adapter.executeCalls).toBe(calls);
    expect(await attemptOf(w, v.commercialIntentId)).toBeUndefined();
    expect([v.state, v.economic.state, v.noEffectProven, v.cancelRequested]).toEqual([
      'CANCELLED',
      'FAILED',
      true,
      true,
    ]);
    const plan = await rowOf(w, 'recovery_plans', o.action.planId);
    expect([plan.state, plan.in_flight_reconciliation]).toEqual(['INVALIDATED', false]);
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect(await incidentState(w, o.action.incidentId)).toBe('PLANNING');
  });

  it('revocation after linearization preserves and reconciles the in-flight effect without duplicating it', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    w.adapter.nextModes.push('DROP_RESPONSE');
    const calls = w.adapter.executeCalls;
    const sent = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    expect(sent.state).toBe('UNKNOWN');
    await revokeOrder(w.db.pool, w.approver, { orderId: o.orderId, reasonCode: 'OPERATOR_CANCELLED' });
    const revoked = await view(w, o.orderId);
    expect([revoked.state, revoked.cancelRequested, revoked.noEffectProven]).toEqual(['UNKNOWN', true, false]);
    expect(revoked.changes.map((c) => c.changeKind)).toContain('REVOCATION');
    // The effect is reconciled to its authoritative outcome under the pinned historical authority, never erased.
    await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    const done = await reconcileOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    expect([done.state, done.economic.state]).toEqual(['ACCEPTED', 'CONFIRMED']);
    expect(w.adapter.executeCalls).toBe(calls + 1);
    expect(done.blockedReason).not.toBeNull();
    const plan = await rowOf(w, 'recovery_plans', o.action.planId);
    expect([plan.state, plan.in_flight_reconciliation]).toEqual(['INVALIDATED', true]);
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect(await incidentState(w, o.action.incidentId)).toBe('ESCALATED');
  });

  it('racing revocation against dispatch yields exactly one of the two outcomes, never two sends', async () => {
    for (let i = 0; i < 4; i++) {
      const o = await orderFor(w, 'PART_PURCHASE');
      const calls = w.adapter.executeCalls;
      await Promise.allSettled([
        dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w)),
        revokeOrder(w.db.pool, w.approver, { orderId: o.orderId, reasonCode: 'OPERATOR_CANCELLED' }),
      ]);
      const v = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
      const sends = w.adapter.executeCalls - calls;
      if (sends === 0) expect([v.state, v.economic.state, v.noEffectProven]).toEqual(['CANCELLED', 'FAILED', true]);
      else {
        expect(sends).toBe(1);
        expect(v.economic.state).toBe('CONFIRMED');
        expect([v.cancelRequested, v.noEffectProven]).toEqual([true, false]);
      }
    }
  });
});

describe('T-044 completion is not recovery (INV-14)', () => {
  it('delivery and verification move the incident only to VERIFYING and the plan to COMPLETED, releasing nothing', async () => {
    const o = await sentOrder('PART_PURCHASE');
    const ledger = async () =>
      (
        await w.db.pool.query(`SELECT count(*)::int AS n FROM budget_ledger_entries WHERE tenant_id = $1`, [
          w.tenant.tenantId,
        ])
      ).rows[0].n;
    const before = await ledger();
    await report(o.sent, [['ordered'], ['shipped'], ['delivered']]);
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect(await incidentState(w, o.action.incidentId)).toBe('VERIFYING');
    expect((await rowOf(w, 'recovery_plans', o.action.planId)).state).toBe('EXECUTING');
    const verified = await recordFulfillmentVerification(w.db.pool, w.operator, {
      orderId: o.orderId,
      outcome: 'VERIFIED',
      idempotencyKey: w.key('verify'),
    });
    expect(verified.state).toBe('VERIFIED');
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect((await rowOf(w, 'recovery_plans', o.action.planId)).state).toBe('COMPLETED');
    expect(await incidentState(w, o.action.incidentId)).toBe('VERIFYING');
    const gate = await getFulfillmentGate(w.db.pool, w.viewerCtx, o.orderId);
    expect([gate.installable, gate.provesRecovery]).toEqual([true, false]);
    expect(await ledger()).toBe(before);
    expect((await rowOf(w, 'incidents', o.action.incidentId)).recovered_at).toBeNull();
  });

  it('reported service completion is not recovery and a disputed job reopens policy', async () => {
    const o = await sentOrder('SERVICE_JOB');
    await report(o.sent, [['scheduled'], ['en_route'], ['arrived'], ['in_progress'], ['work_complete']]);
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect(await incidentState(w, o.action.incidentId)).toBe('VERIFYING');
    const d = await recordFulfillmentVerification(w.db.pool, w.operator, {
      orderId: o.orderId,
      outcome: 'DISPUTED',
      idempotencyKey: w.key('dispute'),
    });
    expect(d.state).toBe('DISPUTED');
    expect(d.changes.map((c) => c.changeKind)).toContain('DISPUTE');
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect(await incidentState(w, o.action.incidentId)).toBe('ESCALATED');
  });
});
