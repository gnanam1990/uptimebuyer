// T-039 / T-040 self security review regressions: authority forgery by a database writer, execution-reference misuse
// (wrong kind, replay, expiry), a provider claiming more than was reserved, and a refund callback that tries to act as
// spend authority. Provider effects come from the RECORDED_CONTRACT adapter (not Kite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorityReference, issueReference } from '@uptimebuyer/commerce';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import {
  attemptOf,
  conservation,
  createBrokerWorld,
  freshApproval,
  inProcessBroker,
  intentRef,
  paidPlanAction,
  readyIntent,
  rejection,
  rowOf,
  sessionRef,
  sleep,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t040s');
});
afterAll(async () => w?.close());

describe('T-039/T-040 security review regressions', () => {
  it('a database writer cannot forge an authority: a copied signature over a changed scope is refused by the broker', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    const approvalId = await freshApproval(w, r.action);
    const src = await rowOf(w, 'execution_authorities', r.auth.authority.executionAuthorityId);
    const forgedId = 'xau_forged-scope-0001';
    // Same approval-bound fields (so the insert guard accepts it), a widened purpose, and a copied signature.
    await w.db.pool.query(
      `INSERT INTO execution_authorities (tenant_id, id, approval_id, incident_id, site_id, asset_revision_id,
         evidence_revision_id, policy_revision_id, plan_hash, action_digest, subject_type, subject_id, semantic_operation,
         provider_account_id, provider_account_revision_id, merchant_id, purpose, allowed_action_kinds,
         per_action_limit_minor, base_limit_minor, currency, issued_at, expires_at, scope_digest, signature_algorithm,
         signature_key_id, signature_value, status, issued_by_kind, issued_by_id)
       SELECT tenant_id, $3, $4, incident_id, site_id, asset_revision_id, evidence_revision_id, policy_revision_id,
              plan_hash, action_digest, subject_type, subject_id, semantic_operation, provider_account_id,
              provider_account_revision_id, merchant_id, 'GIFT_CARD_PURCHASE', allowed_action_kinds, per_action_limit_minor,
              base_limit_minor, currency, issued_at, expires_at, scope_digest, signature_algorithm, signature_key_id,
              signature_value, 'ACTIVE', 'WORKER', 'attacker'
         FROM execution_authorities WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, src.id, forgedId, approvalId],
    );
    await w.db.pool.query(
      `INSERT INTO execution_authority_sessions (tenant_id, id, execution_authority_id, provider_account_id,
         provider_account_revision_id, client_operation_id, idempotency_key, request_digest, transport_state,
         external_outcome_state, adapter_capability)
       VALUES ($1, 'kss_forged-0001', $2, $3, $4, 'op_forged-0001', 'kite-session.forged-0001', $5, 'PREPARED', 'PROPOSED', 'ELIGIBLE')`,
      [
        w.tenant.tenantId,
        forgedId,
        src.provider_account_id,
        src.provider_account_revision_id,
        `sha256:${'f'.repeat(64)}`,
      ],
    );
    const refused = await rejection(broker.activateSession(sessionRef(w, forgedId)));
    expect(refused.reasonCode).toBe('AUTHORITY_SIGNATURE_INVALID');
    expect(adapter.sessions.size).toBe(1);
  });

  it('execution references are kind-checked, single-use per operation and expire', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await paidPlanAction(w);
    const r = await readyIntent(w, broker, p);
    const xau = r.auth.authority.executionAuthorityId;
    // An authority reference cannot execute; an intent reference cannot activate a session.
    expect((await rejection(broker.execute(authorityReference(w.referenceSigner, w.tenant.tenantId, xau)))).code).toBe(
      'EXECUTION_REFERENCE_INVALID',
    );
    expect((await rejection(broker.activateSession(intentRef(w, r.intentId)))).code).toBe(
      'EXECUTION_REFERENCE_INVALID',
    );
    // An expired reference is refused before any lookup.
    const short = issueReference({ ...w.referenceSigner, ttlMs: 20 }, w.tenant.tenantId, {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: r.intentId,
    } as never);
    await sleep(60);
    expect((await rejection(broker.execute(short))).code).toBe('EXECUTION_REFERENCE_INVALID');
    expect(adapter.executeCalls).toBe(0);
    // A captured reconcile reference replayed later performs no second lookup.
    adapter.nextModes.push('DROP_RESPONSE');
    await broker.execute(intentRef(w, r.intentId));
    const rec = intentRef(w, r.intentId);
    await broker.reconcile(rec);
    const lookups = adapter.lookupCalls;
    const replay = await broker.reconcile(rec);
    expect([replay.replay, replay.events.length, adapter.lookupCalls]).toEqual([true, 0, lookups]);
  });

  it('a provider claiming more than the reservation never captures beyond it; the effect goes to manual review', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.captureOverride = 99_999n;
    const out = await broker.execute(intentRef(w, r.intentId));
    expect(out.intent.state).not.toBe('CONFIRMED');
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    expect([i.state, BigInt(i.captured_gross_minor), BigInt(i.open_reserved_minor)]).toEqual(['UNKNOWN', 0n, 18_500n]);
    const a = await attemptOf(w, r.intentId);
    expect([a.adapter_capability, a.reason_code]).toEqual(['UNSUPPORTED', 'CAPTURE_OUTSIDE_RESERVATION']);
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('a refund callback can never authorize spend: available stays consumed and no reserve is possible', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    await broker.execute(intentRef(w, r.intentId));
    const key = (await attemptOf(w, r.intentId)).idempotency_key;
    adapter.addReturn(key, { kind: 'REFUND', providerEventId: 'rf-sec-1', amountMinor: 18_500n });
    await broker.reconcile(intentRef(w, r.intentId));
    const acc = (
      await w.db.pool.query(`SELECT * FROM budget_accounts WHERE tenant_id = $1 AND execution_authority_id = $2`, [
        w.tenant.tenantId,
        r.auth.authority.executionAuthorityId,
      ])
    ).rows[0];
    expect([BigInt(acc.available_minor), BigInt(acc.net_settled_minor)]).toEqual([0n, 0n]);
    // Even a RESERVE inserted straight into the ledger for this (refunded) intent is refused.
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    await expect(
      w.db.pool.query(
        `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, intent_id, movement_type, amount_minor, currency,
           provider_account_id, provider_account_revision_id, provider_event_key, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ble_sec-reserve-1', $2, $3, 'RESERVE', 1, 'USD', $4, $5, 'sec-reserve-1', 'X', 'WORKER', 'x')`,
        [w.tenant.tenantId, i.budget_account_id, i.id, i.provider_account_id, i.provider_account_revision_id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(UB098|23505)$/) });
  });
});
