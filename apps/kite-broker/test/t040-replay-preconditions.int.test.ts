// T-040 regressions for two HIGH review findings on same-key replay. (A) A replay is an execution, so it must pass the
// SAME preconditions as linearization — including the M06 decision gate, the stored action digest, the amount/bound
// check and the intent-to-authority binding — and refuse (effect UNKNOWN, reservation held, manual) when any fails.
// (B) "I refused to send now" proves nothing about an earlier send: a not-sent refusal is no-effect proof only on the
// FIRST execute of an attempt that was never handed off; on replay/reconcile, or after an observed handoff, it routes
// to manual review and keeps the reservation. Tampering uses the dev superuser to disable row guards, simulating a
// database writer. Provider effects come from the RECORDED_CONTRACT adapter (not Kite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import {
  attemptOf,
  createBrokerWorld,
  freshApproval,
  inProcessBroker,
  intentRef,
  issue,
  readyIntent,
  rowOf,
  sessionRef,
  sleep,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  // Offers stay fresh for 75 s (candidates are registered as observed 60 s ago), so a replay can outlive its decision.
  w = await createBrokerWorld('t040r', { maxOfferAgeMs: 75_000 });
});
afterAll(async () => w?.close());

async function unknownReplayIntent() {
  const adapter = new RecordedContractAdapter({ lookupByClientOperation: false, sameKeyReplay: true });
  const broker = inProcessBroker(w, adapter);
  const r = await readyIntent(w, broker);
  adapter.nextModes.push('TIMEOUT_BEFORE_HANDOFF'); // nothing reached the provider: a replay WOULD create the effect
  expect((await broker.execute(intentRef(w, r.intentId))).intent.state).toBe('UNKNOWN');
  return { adapter, broker, r };
}
async function tamper(table: string, sql: string, params: unknown[]) {
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await c.query(sql, params);
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
async function expectManual(intentId: string, adapter: RecordedContractAdapter, reason: string) {
  expect(adapter.executeCalls).toBe(0);
  const i = await rowOf(w, 'commercial_intents', intentId);
  expect([i.state, BigInt(i.open_reserved_minor)]).toEqual(['UNKNOWN', 18_500n]);
  const a = await attemptOf(w, intentId);
  expect([a.adapter_capability, a.reason_code]).toEqual(['UNSUPPORTED', reason]);
}

describe('T-040 replay preconditions and not-sent refusals', () => {
  it('A1: the M06 decision gate runs before a replay (stale offer -> refused, reserved, manual)', async () => {
    const { adapter, broker, r } = await unknownReplayIntent();
    const age =
      Date.now() - Date.parse((await rowOf(w, 'candidate_actions', r.action.candidateActionId)).offer_observed_at);
    await sleep(Math.max(0, 76_000 - age));
    await broker.reconcile(intentRef(w, r.intentId));
    await expectManual(r.intentId, adapter, 'REPLAY_AUTHORITY_NOT_CURRENT');
  });

  it('A2: a tampered stored action digest refuses the replay', async () => {
    const { adapter, broker, r } = await unknownReplayIntent();
    await tamper(
      'candidate_actions',
      `UPDATE candidate_actions SET action_digest = $3 WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, r.action.candidateActionId, `action.v1:sha256:${'1'.repeat(64)}`],
    );
    await broker.reconcile(intentRef(w, r.intentId));
    await expectManual(r.intentId, adapter, 'REPLAY_AUTHORITY_NOT_CURRENT');
  });

  it('A3: an intent amount outside the per-action bound refuses the replay', async () => {
    const { adapter, broker, r } = await unknownReplayIntent();
    await tamper(
      'commercial_intents',
      `UPDATE commercial_intents SET max_amount_minor = 18600 WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, r.intentId],
    );
    await broker.reconcile(intentRef(w, r.intentId));
    await expectManual(r.intentId, adapter, 'REPLAY_AUTHORITY_NOT_CURRENT');
  });

  it('A4: an intent no longer bound to its authority’s approval refuses the replay', async () => {
    const { adapter, broker, r } = await unknownReplayIntent();
    const other = await freshApproval(w, r.action);
    await tamper(
      'commercial_intents',
      `UPDATE commercial_intents SET approval_id = $3 WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, r.intentId, other],
    );
    await broker.reconcile(intentRef(w, r.intentId));
    await expectManual(r.intentId, adapter, 'REPLAY_AUTHORITY_NOT_CURRENT');
  });

  it('B1: a not-sent refusal during replay never proves no effect: UNKNOWN, reserved, manual', async () => {
    const { adapter, broker, r } = await unknownReplayIntent();
    adapter.nextModes.push('REFUSE_NOT_SENT');
    await broker.reconcile(intentRef(w, r.intentId));
    await expectManual(r.intentId, adapter, 'BOUND_SESSION_NOT_ACTIVE');
  });

  it('B2: a not-sent claim after an observed handoff on first execute is not no-effect proof either', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.nextModes.push('REFUSE_AFTER_HANDOFF');
    await broker.execute(intentRef(w, r.intentId));
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    expect([i.state, BigInt(i.open_reserved_minor)]).toEqual(['UNKNOWN', 18_500n]);
    const a = await attemptOf(w, r.intentId);
    expect([a.external_outcome_state, a.adapter_capability]).toEqual(['UNKNOWN', 'UNSUPPORTED']);
  });

  it('B3: a not-sent session refusal never fabricates REQUESTED or FAILED for the Kite session', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await readyIntent(w, broker).then((x) => x.action);
    const auth = await issue(w, p, await freshApproval(w, p));
    adapter.sessionModes.push('REFUSE_NOT_SENT');
    const out = await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    expect([out.session.transportState, out.session.externalOutcomeState]).toEqual([
      'DEFINITE_NO_EFFECT',
      'AUTHORIZED',
    ]);
  });
});
