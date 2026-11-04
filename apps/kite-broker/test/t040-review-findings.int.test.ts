// T-037 / T-040 regressions for the coordinator's automated security review (three MEDIUM findings):
// (1) same-key replay must never re-send under authority that is no longer current — it routes to manual review and
// keeps the reservation; (2) every paid execution is bound to the authority's own confirmed Kite session; (3) the
// provider session lifetime is computed from the database clock and never outlives the authority.
// Provider effects come from the RECORDED_CONTRACT adapter (not Kite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeExecutionAuthorityStatus } from '@uptimebuyer/commerce';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import {
  attemptOf,
  createBrokerWorld,
  inProcessBroker,
  intentRef,
  issue,
  newEvidenceRevision,
  paidPlanAction,
  readyIntent,
  rowOf,
  sessionRef,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t040f');
});
afterAll(async () => w?.close());

describe('T-040 review findings: replay revalidation, session binding, session lifetime', () => {
  it('finding 1: same-key replay is refused once the authority is revoked or a bound revision changed; the effect stays UNKNOWN and reserved', async () => {
    const replay = new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: true });
    const broker = inProcessBroker(w, replay);
    // The first send never reached the provider (timeout before handoff): a replay now WOULD create the effect.
    const r = await readyIntent(w, broker);
    replay.nextModes.push('TIMEOUT_BEFORE_HANDOFF');
    expect((await broker.execute(intentRef(w, r.intentId))).intent.state).toBe('UNKNOWN');
    await changeExecutionAuthorityStatus(w.db.pool, w.approver, {
      executionAuthorityId: r.auth.authority.executionAuthorityId,
      to: 'REVOKED',
      reasonCode: 'OPERATOR_REVOKE',
    });
    await broker.reconcile(intentRef(w, r.intentId));
    expect(replay.executeCalls).toBe(0);
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    expect([i.state, BigInt(i.open_reserved_minor)]).toEqual(['UNKNOWN', 18_500n]);
    const a = await attemptOf(w, r.intentId);
    expect([a.adapter_capability, a.reason_code]).toEqual(['UNSUPPORTED', 'REPLAY_AUTHORITY_NOT_CURRENT']);

    // Same with a bound evidence revision change instead of a revocation.
    const r2 = await readyIntent(w, broker);
    replay.nextModes.push('TIMEOUT_BEFORE_HANDOFF');
    await broker.execute(intentRef(w, r2.intentId));
    await newEvidenceRevision(w, r2.action);
    await broker.reconcile(intentRef(w, r2.intentId));
    expect(replay.executeCalls).toBe(0);
    expect((await attemptOf(w, r2.intentId)).reason_code).toBe('REPLAY_AUTHORITY_NOT_CURRENT');
    expect(BigInt((await rowOf(w, 'commercial_intents', r2.intentId)).open_reserved_minor)).toBe(18_500n);
  });

  it('finding 2: execution under authority A carries A’s confirmed provider session reference, never B’s', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const a = await readyIntent(w, broker);
    const b = await readyIntent(w, broker);
    const sessionA = (
      await w.db.pool.query(
        `SELECT provider_session_ref FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
        [w.tenant.tenantId, a.auth.authority.executionAuthorityId],
      )
    ).rows[0].provider_session_ref;
    const sessionB = (
      await w.db.pool.query(
        `SELECT provider_session_ref FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
        [w.tenant.tenantId, b.auth.authority.executionAuthorityId],
      )
    ).rows[0].provider_session_ref;
    expect(sessionA).not.toBe(sessionB);
    await broker.execute(intentRef(w, a.intentId));
    const used = adapter.assessed.find((x) => x.commercialIntentId === a.intentId)!;
    expect(used.providerSessionRef).toBe(sessionA);
    // An adapter refusal before anything was handed off is definite no effect and never fabricates REQUESTED.
    const c = await readyIntent(w, broker);
    adapter.nextModes.push('REFUSE_NOT_SENT');
    expect((await broker.execute(intentRef(w, c.intentId))).intent.state).toBe('FAILED');
    const att = await attemptOf(w, c.intentId);
    expect([att.transport_state, att.external_outcome_state]).toEqual(['DEFINITE_NO_EFFECT', 'AUTHORIZED']);
    expect(BigInt((await rowOf(w, 'commercial_intents', c.intentId)).open_reserved_minor)).toBe(0n);
  });

  it('finding 3: the session lifetime handed to the provider comes from the database clock and never exceeds the authority', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await paidPlanAction(w, 18_500n, { expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const auth = await issue(w, p);
    await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const scope = adapter.sessionScopes.at(-1)!;
    const dbRemaining = (
      await w.db.pool.query(
        `SELECT floor(extract(epoch FROM expires_at - clock_timestamp()))::int AS s FROM execution_authorities WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, auth.authority.executionAuthorityId],
      )
    ).rows[0].s;
    expect(scope.remainingSeconds).toBeLessThanOrEqual(120);
    expect(scope.remainingSeconds).toBeGreaterThanOrEqual(dbRemaining - 2);
    expect(scope.remainingSeconds).toBeLessThanOrEqual(dbRemaining + 1);
  });
});
