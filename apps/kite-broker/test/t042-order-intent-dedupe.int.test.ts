// T-042 — Duplicate order intent suppression (INV-07, NFR-03). Concurrent retries sharing the same action digest and
// execution-authority identity return ONE economic intent and ONE order/job across worker restart (a fresh pool) and
// provider delay; concurrent dispatch reaches the provider once. Fresh authority creates a linked successor only after
// every predecessor for the digest has terminal definite-no-effect proof; a possibly effective predecessor (CONFIRMED
// or UNKNOWN) blocks it, and the order-level partial unique index composes with M09's commercial-intent index.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOrder, requestOrder, revokeOrder } from '@uptimebuyer/orders';
import { RecordedContractAdapter } from '../src/adapters/recorded.js';
import { freshApproval, inProcessBroker, issue, rejection, rowOf, sessionRef } from './helpers.js';
import { brokerDeps, createOrdersWorld, orderFor, paidActionOf, view, type OrdersWorld } from './m10-helpers.js';

let w: OrdersWorld;
beforeAll(async () => {
  w = await createOrdersWorld('t042');
});
afterAll(async () => w?.close());

const count = async (table: string, where: string, params: unknown[]) =>
  (
    await w.db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${where}`, [
      w.tenant.tenantId,
      ...params,
    ])
  ).rows[0].n as number;

describe('T-042 duplicate order intent suppression', () => {
  for (const kind of ['PART_PURCHASE', 'SERVICE_JOB'] as const)
    it(`${kind}: concurrent retries for one digest + authority return one intent and one ${kind === 'PART_PURCHASE' ? 'purchase order' : 'service job'}`, async () => {
      const action = await paidActionOf(w, kind);
      const auth = await issue(w, action);
      await w.broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
      const req = (key: string, pool = w.db.pool) =>
        requestOrder(
          pool,
          w.operator,
          { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: key },
          w.referenceSigner,
        );
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => req(w.key(`retry-${i}`))));
      const ids = new Set(results.map((r) => r.order.orderId));
      const intents = new Set(results.map((r) => r.order.commercialIntentId));
      expect([ids.size, intents.size]).toEqual([1, 1]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const orderId = [...ids][0]!;
      expect(orderId.startsWith(kind === 'PART_PURCHASE' ? 'pur_' : 'sjb_')).toBe(true);
      const table = kind === 'PART_PURCHASE' ? 'purchase_orders' : 'service_jobs';
      const other = kind === 'PART_PURCHASE' ? 'service_jobs' : 'purchase_orders';
      expect(await count(table, 'action_digest = $2', [auth.authority.actionDigest])).toBe(1);
      expect(await count(other, 'action_digest = $2', [auth.authority.actionDigest])).toBe(0);
      expect(await count('commercial_intents', 'action_digest = $2', [auth.authority.actionDigest])).toBe(1);

      // Worker restart: a brand-new pool (no in-process state) converges on the same rows.
      const restarted = new pg.Pool({ connectionString: w.db.url, max: 4 });
      try {
        const again = await req(w.key('after-restart'), restarted);
        expect([again.order.orderId, again.created]).toEqual([orderId, false]);
      } finally {
        await restarted.end();
      }
      // The order carries the pre-egress client operation identity of its intent, fixed before any send.
      const o = await view(w, orderId);
      const i = await rowOf(w, 'commercial_intents', o.commercialIntentId);
      expect([o.clientOperationId, o.state, o.economic.state]).toEqual([i.client_operation_id, 'REQUESTED', 'CREATED']);
    });

  it('concurrent dispatch under provider delay reaches the provider once and never re-sends', async () => {
    const adapter = new RecordedContractAdapter();
    const slow = { ...w, adapter, broker: inProcessBroker(w, adapter) } as OrdersWorld;
    const { orderId } = await orderFor(slow, 'PART_PURCHASE');
    adapter.nextModes.push('HANG');
    const first = dispatchOrder(w.db.pool, w.operator, orderId, brokerDeps(slow));
    await new Promise((r) => setTimeout(r, 300));
    const others = await Promise.all(
      Array.from({ length: 5 }, () => dispatchOrder(w.db.pool, w.operator, orderId, brokerDeps(slow))),
    );
    for (const o of others) expect(o.state).toBe('REQUESTED');
    (adapter as unknown as { hanging: (() => void)[] }).hanging.splice(0).forEach((r) => r());
    await first;
    expect(adapter.executeCalls).toBe(1);
    expect(await count('external_attempts', 'intent_id = $2', [(await view(w, orderId)).commercialIntentId])).toBe(1);
    // A later dispatch after the effect exists is a no-op on the provider side.
    await dispatchOrder(w.db.pool, w.operator, orderId, brokerDeps(slow));
    expect(adapter.executeCalls).toBe(1);
  });

  it('a successor under fresh authority exists only after definite-no-effect proof and links the predecessor', async () => {
    const first = await orderFor(w, 'PART_PURCHASE');
    // Revocation wins before the linearization point: no send, definite no effect, order CANCELLED.
    await revokeOrder(w.db.pool, w.approver, { orderId: first.orderId, reasonCode: 'OPERATOR_CANCELLED' });
    const before = w.adapter.executeCalls;
    const cancelled = await dispatchOrder(w.db.pool, w.operator, first.orderId, brokerDeps(w));
    expect(w.adapter.executeCalls).toBe(before);
    expect([cancelled.state, cancelled.economic.state, cancelled.noEffectProven]).toEqual([
      'CANCELLED',
      'FAILED',
      true,
    ]);

    const approvalId = await freshApproval(w, first.action);
    const second = await orderFor(w, 'PART_PURCHASE', first.action, approvalId);
    const s = await view(w, second.orderId);
    expect(s.actionDigest).toBe(cancelled.actionDigest);
    expect(s.supersedesOrderId).toBe(first.orderId);
    expect(s.executionAuthorityId).not.toBe(cancelled.executionAuthorityId);
    expect((await rowOf(w, 'commercial_intents', s.commercialIntentId)).supersedes_intent_id).toBe(
      cancelled.commercialIntentId,
    );
    // The predecessor lineage is untouched.
    const prior = await view(w, first.orderId);
    expect([prior.state, prior.version, prior.commercialIntentId]).toEqual([
      cancelled.state,
      cancelled.version,
      cancelled.commercialIntentId,
    ]);
  });

  it('a possibly effective predecessor (CONFIRMED or UNKNOWN) blocks any successor order', async () => {
    for (const mode of ['SETTLE', 'DROP_RESPONSE'] as const) {
      const first = await orderFor(w, 'PART_PURCHASE');
      w.adapter.nextModes.push(mode);
      const sent = await dispatchOrder(w.db.pool, w.operator, first.orderId, brokerDeps(w));
      expect(sent.economic.state).toBe(mode === 'SETTLE' ? 'CONFIRMED' : 'UNKNOWN');
      const approvalId = await freshApproval(w, first.action);
      const auth = await issue(w, first.action, approvalId);
      await w.broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));
      const r = await rejection(
        requestOrder(
          w.db.pool,
          w.operator,
          { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: w.key('succ') },
          w.referenceSigner,
        ),
      );
      expect(r.code).toBe('INTENT_SUCCESSOR_BLOCKED');
      expect(await count('purchase_orders', 'action_digest = $2', [sent.actionDigest])).toBe(1);
    }
  });

  it('the database refuses a second live order for one digest even when the service layer is bypassed', async () => {
    const { orderId } = await orderFor(w, 'PART_PURCHASE');
    const r = (
      await w.db.pool.query(`SELECT * FROM purchase_orders WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        orderId,
      ])
    ).rows[0];
    const clone = { ...r, id: `pur_${crypto.randomUUID()}`, version: 1 };
    const cols = Object.keys(clone).filter((k) => !['created_at', 'updated_at'].includes(k));
    await expect(
      w.db.pool.query(
        `INSERT INTO purchase_orders (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((k) => clone[k]),
      ),
    ).rejects.toThrow();
    // A service job cannot be attached to a purchase intent (separate kinds, separate tables).
    const sj = { ...clone, id: `sjb_${crypto.randomUUID()}` };
    delete (sj as Record<string, unknown>).quantity_filled;
    const sjCols = cols.filter((k) => k !== 'quantity_filled');
    await expect(
      w.db.pool.query(
        `INSERT INTO service_jobs (${sjCols.join(', ')}) VALUES (${sjCols.map((_, i) => `$${i + 1}`).join(', ')})`,
        sjCols.map((k) => (sj as Record<string, unknown>)[k]),
      ),
    ).rejects.toThrow(/wrong kind|unique|duplicate/);
  });
});
