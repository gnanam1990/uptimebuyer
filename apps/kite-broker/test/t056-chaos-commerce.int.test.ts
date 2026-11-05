// T-056 chaos restart and recovery — authority, session and payment boundaries (NFR-02, NFR-03, INV-05, INV-07,
// INV-08). Faults are injected through the existing seams (the broker's named linearization hooks, the RECORDED_CONTRACT
// adapter's response modes) and, where no seam existed, a test-only pool that kills the connection at a chosen
// statement or after a provider effect. After each fault a fresh broker instance over a healthy pool ("restart")
// converges. Proven for every case: durable convergence to one definite or reconciling state, exactly one provider
// effect per client operation, the gross/settlement conservation equations at account, intent and capture level, no
// duplicate authority/session/intent, and no autonomous retry without a reconciliation capability.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAuthorityPublicKey, importAuthorityPublicKey, issueExecutionAuthority } from '@uptimebuyer/commerce';
import { RetryPolicy } from '@uptimebuyer/resilience';
import { KiteBroker, type BrokerHooks, type BrokerPoint } from '../src/broker.js';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import type { PaidAdapter } from '../src/adapters/port.js';
import {
  attemptOf,
  conservation,
  createBrokerWorld,
  createIntentFor,
  intentRef,
  issue,
  paidPlanAction,
  rowOf,
  sessionRef,
  sleep,
  type BrokerWorld,
} from './helpers.js';
import { FaultyPool, type FaultRule } from './support/faulty-pool.js';

let w: BrokerWorld;
const adapter = new RecordedContractAdapter();

beforeAll(async () => {
  w = await createBrokerWorld('t056c');
});
afterAll(async () => {
  await w?.close();
});

/** A broker over `pool` (default: healthy). A new instance is a process restart. */
function broker(pool = w.brokerPool, opts: { hooks?: BrokerHooks; adapter?: PaidAdapter; sendLeaseMs?: number } = {}) {
  return new KiteBroker(pool, {
    referenceKeyring: { [w.referenceSigner.keyId]: w.referenceSigner.key },
    authorityKeys: { [w.authoritySigner.keyId]: importAuthorityPublicKey(exportAuthorityPublicKey(w.authoritySigner)) },
    compatibilitySigning: w.signing,
    adapter: opts.adapter ?? adapter,
    sendLeaseMs: opts.sendLeaseMs ?? 300,
    reconcileBaseMs: 50,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });
}
const crash = (): never => {
  throw Object.assign(new Error('process killed'), { code: 'CHAOS_KILL' });
};
async function settle(b: KiteBroker, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await sleep(120);
    await b.sweep();
  }
}
async function expectConserved() {
  const c = await conservation(w);
  expect(c.problems).toEqual([]);
}
const count = async (sql: string, params: unknown[]) => Number((await w.db.pool.query(sql, params)).rows[0].n);

describe('T-056 authority activation boundary', () => {
  it('a crash before the issuance commit leaves no authority; the retry issues exactly one', async () => {
    const p = await paidPlanAction(w);
    const fp = new FaultyPool(w.db.pool, [{ match: /INSERT INTO execution_authorities\b/, phase: 'after' }]);
    await expect(
      issueExecutionAuthority(
        fp.asPool(),
        w.operator,
        { approvalId: p.approvalId, subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
        w.authoritySigner,
      ),
    ).rejects.toMatchObject({ code: '57P01' });
    expect(await count(`SELECT count(*) AS n FROM execution_authorities WHERE approval_id = $1`, [p.approvalId])).toBe(
      0,
    );
    const ok = await issue(w, p);
    expect(ok.created).toBe(true);
    expect(await count(`SELECT count(*) AS n FROM execution_authorities WHERE approval_id = $1`, [p.approvalId])).toBe(
      1,
    );
    expect(
      await count(`SELECT count(*) AS n FROM execution_authority_sessions WHERE execution_authority_id = $1`, [
        ok.authority.executionAuthorityId,
      ]),
    ).toBe(1);
  });

  it('a lost response after the issuance commit is answered idempotently by the retry', async () => {
    const p = await paidPlanAction(w);
    const fp = new FaultyPool(w.db.pool, [{ match: /^\s*COMMIT/i, phase: 'after' }]);
    await expect(
      issueExecutionAuthority(
        fp.asPool(),
        w.operator,
        { approvalId: p.approvalId, subject: { type: 'PLAN_ACTION', id: p.candidateActionId } },
        w.authoritySigner,
      ),
    ).rejects.toMatchObject({ code: '57P01' });
    const again = await issue(w, p);
    expect(again.created).toBe(false);
    expect(await count(`SELECT count(*) AS n FROM execution_authorities WHERE approval_id = $1`, [p.approvalId])).toBe(
      1,
    );
  });
});

describe('T-056 Kite session activation boundary', () => {
  it('a crash before SEND_STARTED commits sends nothing; the restarted broker sends exactly once', async () => {
    const auth = await issue(w, await paidPlanAction(w));
    const before = adapter.sessions.size;
    const fp = new FaultyPool(w.brokerPool, [
      { match: /UPDATE execution_authority_sessions/, phase: 'after', tripAfter: true },
    ]);
    await expect(
      broker(fp.asPool()).activateSession(sessionRef(w, auth.authority.executionAuthorityId)),
    ).rejects.toBeDefined();
    expect(adapter.sessions.size).toBe(before);
    const s = await broker().activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    expect(s.session.externalOutcomeState).toBe('CONFIRMED');
    expect(adapter.sessions.size).toBe(before + 1);
  });

  it('a crash after the provider effect but before the result is persisted reconciles to CONFIRMED by lookup', async () => {
    const auth = await issue(w, await paidPlanAction(w));
    const before = adapter.sessions.size;
    const fp = new FaultyPool(w.brokerPool);
    const dying: PaidAdapter = Object.create(adapter, {
      activateSession: {
        value: async (...args: Parameters<PaidAdapter['activateSession']>) => {
          const out = await adapter.activateSession(...args);
          fp.trip();
          return out;
        },
      },
    });
    await expect(
      broker(fp.asPool(), { adapter: dying }).activateSession(sessionRef(w, auth.authority.executionAuthorityId)),
    ).rejects.toBeDefined();
    expect(adapter.sessions.size).toBe(before + 1);
    const row = await w.db.pool.query(
      `SELECT transport_state FROM execution_authority_sessions WHERE execution_authority_id = $1`,
      [auth.authority.executionAuthorityId],
    );
    expect(row.rows[0].transport_state).toBe('SEND_STARTED');
    const restarted = broker();
    await settle(restarted, 10);
    const s = await w.db.pool.query(
      `SELECT external_outcome_state FROM execution_authority_sessions WHERE execution_authority_id = $1`,
      [auth.authority.executionAuthorityId],
    );
    expect(s.rows[0].external_outcome_state).toBe('CONFIRMED');
    expect(adapter.sessions.size).toBe(before + 1);
  });
});

describe('T-056 provider-send linearization points', () => {
  // Expected convergence per crash point: before/inside the linearization transaction nothing committed, so the
  // restarted broker executes once; after the durable SEND_STARTED marker but before any handoff, authoritative lookup
  // finds no effect and the provider fences the key (definite no-effect FAILED, reservation released); after the
  // provider effect, lookup by the original key confirms the one effect.
  const POINTS: [BrokerPoint, 'CONFIRMED' | 'FAILED', number][] = [
    ['BEFORE_LINEARIZATION', 'CONFIRMED', 1],
    ['IN_LINEARIZATION_BEFORE_COMMIT', 'CONFIRMED', 1],
    ['AFTER_SEND_STARTED', 'FAILED', 0],
    ['AFTER_EFFECT_BEFORE_PERSIST', 'CONFIRMED', 1],
  ];

  it.each(POINTS)(
    'a crash at %s converges to %s with %i provider effect(s) and conserves the ledger',
    async (point, state, effects) => {
      const p = await paidPlanAction(w);
      const auth = await issue(w, p);
      await broker().activateSession(sessionRef(w, auth.authority.executionAuthorityId));
      const created = await createIntentFor(w, auth);
      const intentId = created.intent.commercialIntentId as string;
      await expect(
        broker(w.brokerPool, { hooks: { [point]: crash } }).execute(intentRef(w, intentId)),
      ).rejects.toMatchObject({
        code: 'CHAOS_KILL',
      });
      const restarted = broker();
      const pre = (await rowOf(w, 'commercial_intents', intentId)).state;
      if (pre === 'CREATED') await restarted.execute(intentRef(w, intentId));
      await settle(restarted, 8);
      const after = await rowOf(w, 'commercial_intents', intentId);
      expect(after.state, point).toBe(state);
      expect(BigInt(after.open_reserved_minor), point).toBe(0n);
      const attempt = await attemptOf(w, intentId);
      expect(
        [...adapter.effects.keys()].filter((k) => k === attempt.idempotency_key),
        point,
      ).toHaveLength(effects);
      expect(await count(`SELECT count(*) AS n FROM external_attempts WHERE intent_id = $1`, [intentId])).toBe(1);
      expect(
        await count(
          `SELECT count(*) AS n FROM budget_ledger_entries WHERE intent_id = $1 AND movement_type = 'CAPTURE'`,
          [intentId],
        ),
      ).toBe(effects);
      await expectConserved();
    },
  );

  it('a crash during the reconciliation lookup is retried by the restarted sweep and converges once', async () => {
    adapter.nextModes = ['DROP_RESPONSE'];
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker().activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const intentId = (await createIntentFor(w, auth)).intent.commercialIntentId as string;
    await broker().execute(intentRef(w, intentId));
    expect((await rowOf(w, 'commercial_intents', intentId)).state).toBe('UNKNOWN');
    const dying = broker(w.brokerPool, { hooks: { DURING_LOOKUP: crash } });
    await sleep(120);
    await expect(dying.sweep()).rejects.toMatchObject({ code: 'CHAOS_KILL' });
    await settle(broker(), 10);
    expect((await rowOf(w, 'commercial_intents', intentId)).state).toBe('CONFIRMED');
    await expectConserved();
  });

  it('a killed database connection between reserve and send converges without a duplicate charge', async () => {
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker().activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const intentId = (await createIntentFor(w, auth)).intent.commercialIntentId as string;
    const fp = new FaultyPool(w.brokerPool);
    await expect(
      broker(fp.asPool(), { hooks: { AFTER_SEND_STARTED: () => fp.trip() } }).execute(intentRef(w, intentId)),
    ).rejects.toMatchObject({ code: '57P01' });
    await settle(broker(), 10);
    const after = await rowOf(w, 'commercial_intents', intentId);
    expect(['CONFIRMED', 'FAILED']).toContain(after.state);
    const attempt = await attemptOf(w, intentId);
    expect([...adapter.effects.keys()].filter((k) => k === attempt.idempotency_key).length).toBeLessThanOrEqual(1);
    await expectConserved();
  });
});

describe('T-056 refund boundary', () => {
  it('a crash while applying a provider refund applies it exactly once after restart', async () => {
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker().activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const intentId = (await createIntentFor(w, auth)).intent.commercialIntentId as string;
    await broker().execute(intentRef(w, intentId));
    const attempt = await attemptOf(w, intentId);
    adapter.addReturn(attempt.idempotency_key, {
      kind: 'REFUND',
      providerEventId: `rf-${intentId.slice(4, 16)}`,
      amountMinor: 500n,
    });
    const fp = new FaultyPool(w.brokerPool, [
      { match: /INSERT INTO budget_ledger_entries/, phase: 'after', tripAfter: true },
    ]);
    await expect(broker(fp.asPool()).reconcile(intentRef(w, intentId))).rejects.toBeDefined();
    const restarted = broker();
    await restarted.reconcile(intentRef(w, intentId));
    await restarted.reconcile(intentRef(w, intentId));
    expect(
      await count(`SELECT count(*) AS n FROM budget_ledger_entries WHERE intent_id = $1 AND movement_type = 'REFUND'`, [
        intentId,
      ]),
    ).toBe(1);
    const i = await rowOf(w, 'commercial_intents', intentId);
    expect(BigInt(i.refunded_minor)).toBe(500n);
    await expectConserved();
  });
});

describe('T-056 no autonomous retry without a reconciliation key (INV-08)', () => {
  it('after possible egress with no lookup or same-key replay, the effect stays UNKNOWN and reserved; nothing is re-sent', async () => {
    const blind = new RecordedContractAdapter();
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker(w.brokerPool, { adapter: blind }).activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const intentId = (await createIntentFor(w, auth)).intent.commercialIntentId as string;
    await expect(
      broker(w.brokerPool, { adapter: blind, hooks: { AFTER_SEND_STARTED: crash } }).execute(intentRef(w, intentId)),
    ).rejects.toMatchObject({ code: 'CHAOS_KILL' });
    blind.capability = { lookupByClientOperation: false, sameKeyReplay: false };
    const restarted = broker(w.brokerPool, { adapter: blind });
    await settle(restarted, 6);
    await restarted.reconcile(intentRef(w, intentId)).catch(() => null);
    await settle(restarted, 4);
    const i = await rowOf(w, 'commercial_intents', intentId);
    expect(i.state).toBe('UNKNOWN');
    expect(BigInt(i.open_reserved_minor)).toBeGreaterThan(0n);
    expect(blind.executeCalls).toBe(0);
    const a = await attemptOf(w, intentId);
    expect(a.adapter_capability).toBe('UNSUPPORTED');
    await expectConserved();
    // The shared retry policy draws the same line for every external effect.
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 });
    expect(policy.decide({ attempt: 1, effect: 'EXTERNAL_EFFECT', reconciliationKey: null })).toEqual({
      retry: false,
      reason: 'NO_RECONCILIATION_KEY',
    });
  });

  it('across every chaos case: one intent per action digest and the ledger still conserves', async () => {
    const dup = await w.db.pool.query(
      `SELECT action_digest, count(*) AS n FROM commercial_intents WHERE tenant_id = $1 AND state <> 'FAILED'
        GROUP BY action_digest HAVING count(*) > 1`,
      [w.tenant.tenantId],
    );
    expect(dup.rows).toEqual([]);
    await expectConserved();
  });
});

void (null as unknown as FaultRule);
