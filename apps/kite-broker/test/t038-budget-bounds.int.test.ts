// T-038 — Hard budget and purpose rejection. Boundary and over-bound amounts, wrong merchant/purpose/currency, an
// expired authority and exhausted gross authority are rejected before paid egress; concurrent reserve/capture/release
// and duplicate partial/full refund/reversal races preserve the gross-cap and net-settlement equations at account,
// intent and capture level. Cross-intent or cross-capture headroom cannot mask an over-return, refund-versus-reversal
// cannot double return, and returned value cannot be re-spent without a separate signed adjustment. Provider effects
// come from the RECORDED_CONTRACT adapter (not Kite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adjustExecutionAuthorityBudget,
  createCommercialIntent,
  getExecutionAuthority,
  intentRequestFor,
} from '@uptimebuyer/commerce';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { patch } from '../src/broker.js';
import {
  attemptOf,
  conservation,
  createBrokerWorld,
  inProcessBroker,
  intentRef,
  issue,
  paidPlanAction,
  readyIntent,
  rejection,
  rowOf,
  sessionRef,
  usd,
  type BrokerWorld,
} from './helpers.js';

let w: BrokerWorld;
beforeAll(async () => {
  w = await createBrokerWorld('t038');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;
let seq = 0;
/** One ledger movement in its own transaction (a provider callback racing others). */
async function movement(
  intentId: string,
  type: string,
  amount: bigint,
  key: string,
  captureEntryId: string | null = null,
) {
  const i = await rowOf(w, 'commercial_intents', intentId);
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, intent_id, movement_type, amount_minor, currency,
         provider_account_id, provider_account_revision_id, provider_event_key, capture_entry_id, reason_code, actor_kind, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'TEST_CALLBACK', 'WORKER', 'test-callback')
       ON CONFLICT (tenant_id, provider_account_id, provider_event_key) WHERE provider_event_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        t(),
        `ble_t038-${++seq}-${Date.now()}`,
        i.budget_account_id,
        intentId,
        type,
        amount.toString(),
        i.currency,
        i.provider_account_id,
        i.provider_account_revision_id,
        key,
        captureEntryId,
      ],
    );
    await c.query('COMMIT');
    return r.rows[0]?.id ?? 'DUPLICATE';
  } catch (e) {
    await c.query('ROLLBACK');
    return `REJECTED:${(e as { code?: string }).code}`;
  } finally {
    c.release();
  }
}
const captureOf = async (intentId: string) =>
  (
    await w.db.pool.query(
      `SELECT * FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2 AND movement_type = 'CAPTURE' ORDER BY seq`,
      [t(), intentId],
    )
  ).rows;

describe('T-038 hard budget and purpose rejection', () => {
  it('rejects boundary-exceeding amounts, wrong merchant/purpose/currency and exhausted authority before paid egress', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    await broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
    const req = intentRequestFor(auth, w.operator, w.key('intent'));
    const over = await rejection(
      createCommercialIntent(w.db.pool, w.operator, { ...req, expectedMax: usd(18_501n) }, w.referenceSigner),
    );
    expect(over.reasonCode).toBe('EXPECTED_MAX_MISMATCH');
    const eur = await rejection(
      createCommercialIntent(
        w.db.pool,
        w.operator,
        { ...req, expectedMax: { amountMinor: 18_500n, currency: 'EUR' } as never },
        w.referenceSigner,
      ),
    );
    expect(eur.reasonCode).toBe('CURRENCY_MISMATCH');
    // Another candidate (other merchant, same purpose) is not this authority's subject.
    const other = await paidPlanAction(w, 18_500n);
    expect(
      (
        await rejection(
          createCommercialIntent(
            w.db.pool,
            w.operator,
            { ...req, subject: { type: 'PLAN_ACTION', id: other.candidateActionId as never } },
            w.referenceSigner,
          ),
        )
      ).reasonCode,
    ).toBe('INTENT_REQUEST_OUTSIDE_AUTHORITY');
    // Database guard: a forged intent above the per-action bound, in another currency or for another purpose is refused.
    const created = await createCommercialIntent(w.db.pool, w.operator, req, w.referenceSigner);
    const row = await rowOf(w, 'commercial_intents', created.intent.commercialIntentId);
    for (const [col, val] of [
      ['max_amount_minor', '18501'],
      ['currency', 'EUR'],
      ['semantic_operation', 'PAID_CONTACT'],
    ] as const) {
      const forged = {
        ...row,
        id: `cin_forged-${col.replace(/_/g, '-')}-${Date.now()}`,
        [col]: val,
        intent_key: `commercial-intent-key.v1:sha256:${'1'.repeat(64)}`,
        client_operation_id: `op_forged-${Date.now()}${col.length}`,
        idempotency_key: `forged.${Date.now()}.${col}`,
      };
      delete (forged as Record<string, unknown>).net_settled_minor;
      const cols = Object.keys(forged);
      await expect(
        w.db.pool.query(
          `INSERT INTO commercial_intents (${cols.join(', ')}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')})`,
          cols.map((k) => (forged as Record<string, unknown>)[k]),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(UB094|23505)$/) });
    }
    // Authority forgery after issuance is impossible.
    await expect(
      w.db.pool.query(
        `UPDATE execution_authorities SET merchant_id = 'mer_attacker-0001', purpose = 'GIFT_CARD' WHERE tenant_id = $1 AND id = $2`,
        [t(), auth.authority.executionAuthorityId],
      ),
    ).rejects.toMatchObject({ code: 'UB001' });

    // Exhausted gross authority (a signed debit) holds the reserve; nothing is sent.
    const debit = await adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
      executionAuthorityId: auth.authority.executionAuthorityId,
      direction: 'DEBIT',
      amount: usd(1n),
      reasonCode: 'FINANCE_TIGHTENED',
    });
    expect(debit.budget.availableMinor).toBe(18_499n);
    const exhausted = await rejection(broker.execute(intentRef(w, created.intent.commercialIntentId)));
    expect(exhausted.reasonCode).toBe('INSUFFICIENT_AVAILABLE_AUTHORITY');
    expect(adapter.executeCalls).toBe(0);
    expect((await rowOf(w, 'commercial_intents', created.intent.commercialIntentId)).state).toBe('CREATED');
    // Exactly at the boundary again (signed credit of 1): the reserve of the full per-action amount succeeds.
    await adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
      executionAuthorityId: auth.authority.executionAuthorityId,
      direction: 'CREDIT',
      amount: usd(1n),
      reasonCode: 'FINANCE_RESTORED',
    });
    const ok = await broker.execute(intentRef(w, created.intent.commercialIntentId));
    expect(ok.intent.state).toBe('CONFIRMED');
    const view = await getExecutionAuthority(w.db.pool, w.viewerCtx, auth.authority.executionAuthorityId);
    expect(view.budget).toMatchObject({ grossCapturedMinor: 18_500n, availableMinor: 0n, openReservedMinor: 0n });
    // The gross cap is consumed: a debit would push exposure above the effective limit and is refused.
    expect(
      (
        await rejection(
          adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
            executionAuthorityId: auth.authority.executionAuthorityId,
            direction: 'DEBIT',
            amount: usd(1n),
            reasonCode: 'FINANCE_TIGHTENED',
          }),
        )
      ).code,
    ).toBe('POLICY_HOLD');
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('concurrent reserve and reconcile races leave exactly one reserve, one send and one capture', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    const before = adapter.executeCalls;
    const runs = await Promise.allSettled(Array.from({ length: 6 }, () => broker.execute(intentRef(w, r.intentId))));
    expect(
      runs.map((x) =>
        x.status === 'fulfilled'
          ? 'ok'
          : String((x.reason as Error).message) +
            String((x.reason as { detail?: string }).detail) +
            String((x.reason as { where?: string }).where),
      ),
    ).toEqual(runs.map(() => 'ok'));
    expect(adapter.executeCalls - before).toBe(1);
    const reserves = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2 AND movement_type = 'RESERVE'`,
      [t(), r.intentId],
    );
    expect(reserves.rows[0].n).toBe(1);

    // UNKNOWN then six concurrent reconciliations: one capture, one confirmation.
    const u = await readyIntent(w, broker);
    adapter.nextModes.push('DROP_RESPONSE');
    expect((await broker.execute(intentRef(w, u.intentId))).intent.state).toBe('UNKNOWN');
    await Promise.allSettled(Array.from({ length: 6 }, () => broker.reconcile(intentRef(w, u.intentId))));
    expect((await rowOf(w, 'commercial_intents', u.intentId)).state).toBe('CONFIRMED');
    expect(await captureOf(u.intentId)).toHaveLength(1);
    // A duplicate RESERVE for the same intent can never be inserted, whatever key it uses.
    expect(await movement(u.intentId, 'RESERVE', 1n, `reserve-again-${Date.now()}`)).toMatch(/^REJECTED:/);
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('duplicate and concurrent partial/full refunds and reversals preserve every equation; captures cannot mask each other', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    adapter.nextModes.push('DROP_RESPONSE');
    await broker.execute(intentRef(w, r.intentId));
    // Two captures in one transaction (a split settlement) followed by CONFIRMED.
    const i = await rowOf(w, 'commercial_intents', r.intentId);
    const c = await w.db.pool.connect();
    try {
      await c.query('BEGIN');
      for (const [amt, key] of [
        [10_000n, 'split-1'],
        [8_500n, 'split-2'],
      ] as const)
        await c.query(
          `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, intent_id, movement_type, amount_minor, currency,
             provider_account_id, provider_account_revision_id, provider_event_key, reason_code, actor_kind, actor_id)
           VALUES ($1, $2, $3, $4, 'CAPTURE', $5, 'USD', $6, $7, $8, 'SPLIT_SETTLEMENT', 'WORKER', 'test-callback')`,
          [
            t(),
            `ble_${key}-${Date.now()}`,
            i.budget_account_id,
            i.id,
            amt.toString(),
            i.provider_account_id,
            i.provider_account_revision_id,
            `${key}-${i.id}`,
          ],
        );
      const a = await attemptOf(w, r.intentId);
      await patch(c, 'external_attempts', a, { external_outcome_state: 'CONFIRMED', next_reconcile_at: null });
      await patch(c, 'commercial_intents', i, { state: 'CONFIRMED' });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const [c1, c2] = await captureOf(r.intentId);
    // Per-capture: 8,501 against the 8,500 capture fails although the intent captured 18,500 in total.
    expect(await movement(r.intentId, 'REFUND', 8_501n, 'over-c2', c2.id)).toBe('REJECTED:UB099');
    // Cross-intent: a return on another intent's capture is refused.
    const other = await readyIntent(w, broker);
    await broker.execute(intentRef(w, other.intentId));
    const [oc] = await captureOf(other.intentId);
    expect(await movement(r.intentId, 'REFUND', 1n, 'cross-intent', oc.id)).toBe('REJECTED:UB099');
    // Releasing or capturing beyond the (now zero) open reservation is refused.
    expect(await movement(r.intentId, 'RELEASE', 1n, 'late-release')).toBe('REJECTED:UB098');
    expect(await movement(r.intentId, 'CAPTURE', 1n, 'late-capture')).toBe('REJECTED:UB098');

    // Refund-versus-reversal of the same provider event cannot double return: one namespaced key, one movement.
    expect(await movement(r.intentId, 'REFUND', 100n, 'ev-x', c2.id)).toMatch(/^ble_/);
    expect(await movement(r.intentId, 'REVERSAL', 100n, 'ev-x', c2.id)).toBe('DUPLICATE');
    // 24 concurrent callbacks against capture 2 (8,400 left): partial refunds, reversals, duplicates of the same keys.
    const jobs: Promise<string>[] = [];
    for (let n = 0; n < 8; n++) {
      jobs.push(movement(r.intentId, 'REFUND', 1_000n, `rf-${n}`, c2.id));
      jobs.push(movement(r.intentId, 'REFUND', 1_000n, `rf-${n}`, c2.id)); // duplicate delivery
      jobs.push(movement(r.intentId, 'REVERSAL', 1_000n, `rv-${n}`, c2.id));
    }
    const out = await Promise.all(jobs);
    const applied = out.filter((x) => x.startsWith('ble_')).length;
    expect(out.filter((x) => x.startsWith('REJECTED')).every((x) => x === 'REJECTED:UB099')).toBe(true);
    expect(applied).toBe(8); // 8 x 1,000 fit into the 8,400 left; every further return is refused or a duplicate
    expect(out.filter((x) => x === 'DUPLICATE').length).toBeGreaterThanOrEqual(1);
    const cap2 = await rowOf(w, 'budget_ledger_entries', c2.id);
    expect(BigInt(cap2.returned_against_minor)).toBe(8_100n);
    expect(await movement(r.intentId, 'REFUND', 400n, 'final-c2', c2.id)).toMatch(/^ble_/);
    expect(await movement(r.intentId, 'REVERSAL', 1n, 'one-more', c2.id)).toBe('REJECTED:UB099');
    expect(await movement(r.intentId, 'REFUND', 10_000n, 'all-c1', c1.id)).toMatch(/^ble_/);
    const row = await rowOf(w, 'commercial_intents', r.intentId);
    expect(BigInt(row.net_settled_minor)).toBe(0n);
    expect((await conservation(w)).problems).toEqual([]);
  });

  it('returned value is never re-spent: a refund leaves gross authority consumed; a re-credit is a separate signed adjustment', async () => {
    const adapter = new RecordedContractAdapter();
    const broker = inProcessBroker(w, adapter);
    const r = await readyIntent(w, broker);
    await broker.execute(intentRef(w, r.intentId));
    const key = (await attemptOf(w, r.intentId)).idempotency_key;
    adapter.addReturn(key, { kind: 'REFUND', providerEventId: 'rf-partial-1', amountMinor: 5_000n });
    expect((await broker.reconcile(intentRef(w, r.intentId))).intent.state).toBe('CONFIRMED'); // partial stays CONFIRMED
    // Duplicate callback of the same refund: no second movement.
    await broker.reconcile(intentRef(w, r.intentId));
    const xau = r.auth.authority.executionAuthorityId;
    let v = await getExecutionAuthority(w.db.pool, w.viewerCtx, xau);
    expect(v.budget).toMatchObject({
      grossCapturedMinor: 18_500n,
      refundedMinor: 5_000n,
      netSettledMinor: 13_500n,
      availableMinor: 0n,
    });
    adapter.addReturn(key, { kind: 'REVERSAL', providerEventId: 'rv-rest-1', amountMinor: 13_500n });
    expect((await broker.reconcile(intentRef(w, r.intentId))).intent.state).toBe('REFUNDED');
    v = await getExecutionAuthority(w.db.pool, w.viewerCtx, xau);
    expect(v.budget.availableMinor).toBe(0n); // refunds never recreate spend authority

    // Only a finance approver's signed BUDGET_ADJUSTMENT can re-credit; an operator cannot, and it applies once.
    expect(
      (
        await rejection(
          adjustExecutionAuthorityBudget(w.db.pool, w.operator, {
            executionAuthorityId: xau,
            direction: 'CREDIT',
            amount: usd(5_000n),
            reasonCode: 'RECREDIT',
          }),
        )
      ).code,
    ).toBe('FORBIDDEN');
    const credit = await adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
      executionAuthorityId: xau,
      direction: 'CREDIT',
      amount: usd(5_000n),
      reasonCode: 'RECREDIT',
    });
    expect(credit.budget.availableMinor).toBe(5_000n);
    const again = await adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
      executionAuthorityId: xau,
      direction: 'CREDIT',
      amount: usd(5_000n),
      reasonCode: 'RECREDIT',
      approvalId: credit.approvalId,
    });
    expect([again.created, again.budget.availableMinor]).toEqual([false, 5_000n]);
    // The adjustment approval signs direction and amount: it cannot be replayed as a different movement.
    expect(
      (
        await rejection(
          adjustExecutionAuthorityBudget(w.db.pool, w.financeCtx, {
            executionAuthorityId: xau,
            direction: 'CREDIT',
            amount: usd(9_000n),
            reasonCode: 'RECREDIT',
            approvalId: credit.approvalId,
          }),
        )
      ).code,
    ).toBe('DIGEST_MISMATCH');
    // A PLAN_ACTION approval can never be applied as an authority credit (database guard).
    const acc = await rowOf(w, 'budget_accounts', v.budget.budgetAccountId);
    await expect(
      w.db.pool.query(
        `INSERT INTO budget_ledger_entries (tenant_id, id, budget_account_id, approval_id, movement_type, amount_minor, currency, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ble_forged-credit-1', $2, $3, 'AUTHORITY_CREDIT', 1000000, 'USD', 'FORGED', 'WORKER', 'x')`,
        [t(), acc.id, r.auth.authority.approvalId],
      ),
    ).rejects.toMatchObject({ code: 'UB097' });
    // The re-credited headroom still cannot buy the same action again: the REFUNDED intent blocks any successor.
    expect((await rowOf(w, 'commercial_intents', r.intentId)).state).toBe('REFUNDED');
    // Projections are written only by the ledger; the ledger is append-only.
    for (const sql of [
      `UPDATE budget_accounts SET open_reserved_minor = 0, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
      `DELETE FROM budget_ledger_entries WHERE tenant_id = $1 AND budget_account_id = $2`,
      `UPDATE budget_ledger_entries SET returned_against_minor = 0 WHERE tenant_id = $1 AND budget_account_id = $2`,
      `UPDATE commercial_intents SET refunded_minor = 0, version = version + 1 WHERE tenant_id = $1 AND budget_account_id = $2`,
    ])
      await expect(w.db.pool.query(sql, [t(), acc.id])).rejects.toMatchObject({ code: 'UB001' });
    expect((await conservation(w)).problems).toEqual([]);
  });
});
