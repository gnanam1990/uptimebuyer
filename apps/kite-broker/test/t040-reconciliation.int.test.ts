// T-040 — Unknown payment reconciliation before retry (in-process crash points and races). Crash before egress, after
// the durable SEND_STARTED marker but before handoff (UNKNOWN, never REQUESTED), after the provider effect but before
// the result persists, and during lookup: one client operation/idempotency identity persists throughout, lookup
// converges without a provider reference, and nothing is charged twice. Accepted-only lookup moves UNKNOWN -> SUBMITTED.
// Missing recovery capability is UNSUPPORTED before egress (blocks send) and, after possible egress, UNSUPPORTED while
// the effect stays UNKNOWN and reserved. A policy or evidence revision racing the reserve-plus-SEND_STARTED
// linearization blocks egress when it commits first and leaves the effect reserved and reconcilable when it commits
// after. Crashes are thrown from named broker points; provider effects come from the RECORDED_CONTRACT adapter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCommercialIntent, resolveUnknownIntentManually } from '@uptimebuyer/commerce';
import { publishCompatibilityPolicy, reproduceDecision } from '@uptimebuyer/compatibility';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { APPROVAL_LIMITS, compatibilityPolicy } from '../../../packages/compatibility/test/helpers.js';
import {
  attemptOf,
  attemptOutcomeHistory,
  conservation,
  createBrokerWorld,
  inProcessBroker,
  intentRef,
  newEvidenceRevision,
  readyIntent,
  rejection,
  rowOf,
  sleep,
  transitionsOf,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t040');
});
afterAll(async () => w?.close());

const crash = () => {
  throw new Error('simulated crash');
};
const ledgerCount = async (intentId: string) =>
  (
    await w.db.pool.query(
      `SELECT count(*)::int AS n FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2`,
      [w.tenant.tenantId, intentId],
    )
  ).rows[0].n as number;

describe('T-040 unknown payment reconciliation before retry', () => {
  it('a crash before egress leaves nothing reserved or sent; the intent later executes exactly once', async () => {
    const adapter = new RecordedContractAdapter();
    const crashing = inProcessBroker(w, adapter, { hooks: { IN_LINEARIZATION_BEFORE_COMMIT: crash } });
    const r = await readyIntent(w, crashing);
    await expect(crashing.execute(intentRef(w, r.intentId))).rejects.toThrow('simulated crash');
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('CREATED');
    expect(await attemptOf(w, r.intentId)).toBeUndefined();
    expect(await ledgerCount(r.intentId)).toBe(0);
    expect(adapter.executeCalls).toBe(0);
    const restarted = inProcessBroker(w, adapter);
    expect((await restarted.execute(intentRef(w, r.intentId))).intent.state).toBe('CONFIRMED');
    expect(adapter.executeCalls).toBe(1);
  });

  it('a crash after SEND_STARTED and before handoff reconstructs UNKNOWN (not REQUESTED), holds the reserve and reconciles by the original key', async () => {
    const adapter = new RecordedContractAdapter();
    const crashing = inProcessBroker(w, adapter, { hooks: { AFTER_SEND_STARTED: crash }, sendLeaseMs: 1 });
    const r = await readyIntent(w, crashing);
    const op = (await rowOf(w, 'commercial_intents', r.intentId)).client_operation_id;
    await expect(crashing.execute(intentRef(w, r.intentId))).rejects.toThrow('simulated crash');
    const marker = await attemptOf(w, r.intentId);
    expect([marker.transport_state, marker.external_outcome_state, marker.client_operation_id]).toEqual([
      'SEND_STARTED',
      'AUTHORIZED',
      op,
    ]);
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('RESERVED');
    expect(adapter.executeCalls).toBe(0);

    // Restart recovery: the lapsed marker becomes UNKNOWN, then lookup by the pre-egress key proves no effect.
    const restarted = inProcessBroker(w, adapter);
    const reconstructed = inProcessBroker(
      w,
      new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: false }),
    );
    // First, a broker whose adapter cannot look up only reconstructs UNKNOWN and leaves it reserved for manual review.
    await reconstructed.sweep();
    const unknown = await attemptOf(w, r.intentId);
    expect([unknown.transport_state, unknown.external_outcome_state]).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('UNKNOWN');
    expect(BigInt((await rowOf(w, 'commercial_intents', r.intentId)).open_reserved_minor)).toBe(18_500n);
    expect(await attemptOutcomeHistory(w, r.intentId)).not.toContain('external_attempt.unknown.v1:REQUESTED');
    expect(unknown.adapter_capability).toBe('UNSUPPORTED');
    // Manual-review state is not retried autonomously by any broker.
    await restarted.sweep();
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('UNKNOWN');
    expect(adapter.lookupCalls).toBe(0);
    expect(await transitionsOf(w, r.intentId)).toEqual(['->CREATED', 'CREATED>RESERVED', 'RESERVED>UNKNOWN']);

    // The same scenario with a lookup-capable broker converges to definite no effect by the original key.
    const r2 = await readyIntent(w, crashing);
    await expect(crashing.execute(intentRef(w, r2.intentId))).rejects.toThrow('simulated crash');
    await restarted.sweep();
    const done = await rowOf(w, 'commercial_intents', r2.intentId);
    expect(done.state).toBe('FAILED');
    expect(BigInt(done.open_reserved_minor)).toBe(0n);
    expect(await transitionsOf(w, r2.intentId)).toEqual([
      '->CREATED',
      'CREATED>RESERVED',
      'RESERVED>UNKNOWN',
      'UNKNOWN>FAILED',
    ]);
    // The fenced key can never take effect late: a delayed copy of the request is refused by the provider.
    expect(adapter.fenced.has((await attemptOf(w, r2.intentId)).idempotency_key)).toBe(true);
    expect(adapter.executeCalls).toBe(0);
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('a crash after the provider effect but before the result persists converges by lookup without a provider reference', async () => {
    const adapter = new RecordedContractAdapter();
    const crashing = inProcessBroker(w, adapter, { hooks: { AFTER_EFFECT_BEFORE_PERSIST: crash }, sendLeaseMs: 1 });
    const r = await readyIntent(w, crashing);
    await expect(crashing.execute(intentRef(w, r.intentId))).rejects.toThrow('simulated crash');
    const a = await attemptOf(w, r.intentId);
    // Handoff was observed (REQUESTED) but no provider reference or result was persisted.
    expect([a.transport_state, a.external_outcome_state, a.provider_ref]).toEqual(['SEND_STARTED', 'REQUESTED', null]);
    expect(adapter.effects.size).toBeGreaterThan(0);
    await inProcessBroker(w, adapter).sweep();
    const done = await getCommercialIntent(w.db.pool, w.viewerCtx, r.intentId);
    expect(done.intent.state).toBe('CONFIRMED');
    expect(done.attempt!.providerRef).toMatch(/^rec_/);
    expect(done.attempt!.clientOperationId).toBe(a.client_operation_id);
    expect(adapter.executeCalls).toBe(1); // never re-sent
    expect(done.money.capturedGrossMinor).toBe(18_500n);
  });

  it('a crash during lookup leaves the effect UNKNOWN and the next lookup converges with no duplicate charge', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.nextModes.push('DROP_RESPONSE');
    expect((await broker.execute(intentRef(w, r.intentId))).intent.state).toBe('UNKNOWN');
    const crashing = inProcessBroker(w, adapter, { hooks: { DURING_LOOKUP: crash } });
    await expect(crashing.reconcile(intentRef(w, r.intentId))).rejects.toThrow('simulated crash');
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('UNKNOWN');
    const out = await broker.reconcile(intentRef(w, r.intentId));
    expect(out.intent.state).toBe('CONFIRMED');
    expect([adapter.executeCalls, adapter.lookupCalls]).toEqual([1, 2]);
    expect(await transitionsOf(w, r.intentId)).toEqual([
      '->CREATED',
      'CREATED>RESERVED',
      'RESERVED>UNKNOWN',
      'UNKNOWN>CONFIRMED',
    ]);
  });

  it('an accepted-only lookup moves UNKNOWN -> SUBMITTED without claiming confirmation; later confirmation converges', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.nextModes.push('DROP_RESPONSE');
    await broker.execute(intentRef(w, r.intentId));
    const key = (await attemptOf(w, r.intentId)).idempotency_key;
    adapter.effects.get(key)!.status = 'ACCEPTED';
    const accepted = await broker.reconcile(intentRef(w, r.intentId));
    expect(accepted.intent.state).toBe('SUBMITTED');
    expect(
      accepted.events.map((e) => [e.payload.priorState, e.payload.state, e.payload.attempt?.externalOutcomeState]),
    ).toEqual([['UNKNOWN', 'SUBMITTED', 'ACCEPTED']]);
    expect(BigInt((await rowOf(w, 'commercial_intents', r.intentId)).captured_gross_minor)).toBe(0n);
    // Still only accepted: nothing changes, nothing is re-sent.
    expect((await broker.reconcile(intentRef(w, r.intentId))).intent.state).toBe('SUBMITTED');
    adapter.settle(key);
    expect((await broker.reconcile(intentRef(w, r.intentId))).intent.state).toBe('CONFIRMED');
    expect(adapter.executeCalls).toBe(1);
  });

  it('missing recovery capability is UNSUPPORTED before egress (no send) and, after possible egress, UNSUPPORTED while UNKNOWN stays reserved', async () => {
    const none = new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: false });
    const b0 = inProcessBroker(w, none);
    const r0 = await readyIntent(w, b0);
    const out0 = await b0.execute(intentRef(w, r0.intentId));
    expect([out0.intent.state, out0.events[0]!.payload.reasonCode]).toEqual([
      'FAILED',
      'ADAPTER_CAPABILITY_UNSUPPORTED',
    ]);
    expect(none.executeCalls).toBe(0);

    // Capability discovered absent after the send: the effect is NOT failed; it is UNKNOWN, reserved, manual.
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.nextModes.push('DROP_RESPONSE');
    await broker.execute(intentRef(w, r.intentId));
    adapter.lookupMode = 'UNSUPPORTED';
    await broker.reconcile(intentRef(w, r.intentId));
    const a = await attemptOf(w, r.intentId);
    expect([a.transport_state, a.external_outcome_state, a.adapter_capability, a.next_reconcile_at]).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNSUPPORTED',
      null,
    ]);
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    expect([i.state, BigInt(i.open_reserved_minor)]).toEqual(['UNKNOWN', 18_500n]);
    const calls = adapter.lookupCalls;
    await broker.reconcile(intentRef(w, r.intentId));
    await broker.sweep();
    expect(adapter.lookupCalls).toBe(calls);
    const caps = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND event_type = 'external_attempt.capability_changed.v1' AND aggregate_id = $2`,
      [w.tenant.tenantId, a.id],
    );
    expect(caps.rows[0].n).toBeGreaterThanOrEqual(1);

    // Manual resolution only: an operator cannot, a finance approver can, citing reviewed evidence; reserve released.
    const evidenceDigest = `sha256:${'e'.repeat(64)}`;
    const manual = {
      commercialIntentId: r.intentId,
      resolution: 'NO_EFFECT_PROVED' as const,
      evidenceDigest,
      reasonCode: 'PROVIDER_STATEMENT_REVIEWED',
    };
    expect((await rejection(resolveUnknownIntentManually(w.db.pool, w.operator, manual))).code).toBe('FORBIDDEN');
    const resolved = await resolveUnknownIntentManually(w.db.pool, w.financeCtx, manual);
    expect([resolved.intent.state, resolved.money.openReservedMinor]).toEqual(['FAILED', 0n]);
    expect(resolved.receipts.map((x) => x.kind)).toContain('NO_EFFECT_PROOF');
    expect((await rejection(resolveUnknownIntentManually(w.db.pool, w.financeCtx, manual))).reasonCode).toBe(
      'INTENT_NOT_UNKNOWN',
    );
    // While autonomous reconciliation is still available, manual resolution is refused.
    const auto = await readyIntent(w, broker);
    adapter.lookupMode = 'NORMAL';
    adapter.nextModes.push('DROP_RESPONSE');
    await broker.execute(intentRef(w, auto.intentId));
    expect(
      (
        await rejection(
          resolveUnknownIntentManually(w.db.pool, w.financeCtx, { ...manual, commercialIntentId: auto.intentId }),
        )
      ).reasonCode,
    ).toBe('AUTONOMOUS_RECONCILIATION_AVAILABLE');

    // Provider-guaranteed same-key replay (no lookup): the original effect is recovered, never a second charge.
    const replay = new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: true });
    const rb = inProcessBroker(w, replay);
    const rr = await readyIntent(w, rb);
    replay.nextModes.push('DROP_RESPONSE');
    await rb.execute(intentRef(w, rr.intentId));
    expect((await rb.reconcile(intentRef(w, rr.intentId))).intent.state).toBe('CONFIRMED');
    expect([replay.executeCalls, replay.effects.size]).toEqual([2, 1]);
  });

  it('races a policy or evidence revision against the reserve-plus-SEND_STARTED linearization', async () => {
    const adapter = new RecordedContractAdapter();
    // AFTER: the evidence revision commits while the request is in flight (marker already durable).
    const after = await readyIntent(w, inProcessBroker(w, adapter));
    const inFlight = inProcessBroker(w, adapter, {
      hooks: { AFTER_SEND_STARTED: async () => void (await newEvidenceRevision(w, after.action)) },
    });
    const kept = await inFlight.execute(intentRef(w, after.intentId));
    expect(kept.intent.state).toBe('CONFIRMED'); // the possible effect stays reserved and reconciles, never erased
    expect((await rowOf(w, 'recovery_plans', after.action.planId)).state).toBe('EXECUTING');

    // AFTER (inside the transaction): a new policy publishes while linearization holds its locks.
    const mid = await readyIntent(w, inProcessBroker(w, adapter));
    const before = await readyIntent(w, inProcessBroker(w, adapter));
    const decisionId = (await rowOf(w, 'plan_actions', before.action.planActionId)).compatibility_decision_id;
    const historical = await reproduceDecision(w.db.pool, w.service, decisionId, w.signing);
    const publish = () =>
      publishCompatibilityPolicy(w.db.pool, w.admin, {
        body: { approvalLimits: APPROVAL_LIMITS, compatibility: compatibilityPolicy() },
        source: 'API',
      });
    // The publish starts while the linearization transaction holds its locks; whatever it must serialize on, it
    // commits only after the reserve + SEND_STARTED commit (awaiting it inside the transaction would self-deadlock).
    let pending: Promise<unknown> | null = null;
    const racing = inProcessBroker(w, adapter, {
      hooks: {
        IN_LINEARIZATION_BEFORE_COMMIT: async () => {
          pending = publish();
          await sleep(200);
        },
      },
    });
    const midOut = await racing.execute(intentRef(w, mid.intentId));
    await pending;
    expect(midOut.intent.state).toBe('CONFIRMED');
    expect(midOut.events[0]!.payload.state).toBe('RESERVED');

    // BEFORE: the policy revision committed first, so the next linearization fails definite-no-effect, no egress.
    const calls = adapter.executeCalls;
    await sleep(50);
    const blocked = await inProcessBroker(w, adapter).execute(intentRef(w, before.intentId));
    expect(blocked.intent.state).toBe('FAILED');
    expect(blocked.events[0]!.payload.reasonCode).toMatch(
      /^(APPROVAL_NOT_EXECUTABLE|POLICY_REVISION_NOT_EFFECTIVE|DECISION_NOT_CURRENT)$/,
    );
    expect(adapter.executeCalls).toBe(calls);
    expect(await ledgerCount(before.intentId)).toBe(0);
    // Historical decisions remain reproducible from the revisions that governed them.
    const again = await reproduceDecision(w.db.pool, w.service, decisionId, w.signing);
    expect(again).toEqual(historical);
    expect(historical.reproduced).toBe(true);
    // The FAILED intent is terminal: executing it again does nothing.
    const replay = await inProcessBroker(w, adapter).execute(intentRef(w, before.intentId));
    expect([replay.intent.state, replay.events]).toEqual(['FAILED', []]);
    expect((await conservation(w)).problems).toEqual([]);
  });
});
