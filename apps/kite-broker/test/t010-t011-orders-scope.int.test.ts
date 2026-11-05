// T-010 / T-011 re-run over the M10 tables and commands (INV-16, FR-24). Every new table is tenant-leading with
// composite tenant foreign keys; another tenant (human or worker service) gets the same RESOURCE_UNAVAILABLE as a
// nonexistent id on every read and write path (IDOR); and the role matrix holds: operators/workers request and
// dispatch, operators verify receipt, approvers revoke, viewers only read, the engine only applies observations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dispatchOrder,
  getFulfillmentGate,
  getOrder,
  listIncidentOrders,
  reconcileOrder,
  recordFulfillmentVerification,
  requestOrder,
  revokeOrder,
  syncIncidentForOrder,
  pollFulfillmentStatus,
  FulfillmentAdapterRegistry,
} from '@uptimebuyer/orders';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import { workerService } from '../../../packages/incidents/test/helpers.js';
import { issue, rejection } from './helpers.js';
import { brokerDeps, createOrdersWorld, orderFor, paidActionOf, type OrdersWorld } from './m10-helpers.js';

const M10_TABLES = [
  'purchase_orders',
  'service_jobs',
  'fulfillment_observations',
  'purchase_order_transitions',
  'service_job_transitions',
  'fulfillment_change_proposals',
];

let w: OrdersWorld;
let foreign: Awaited<ReturnType<typeof seedTenant>>;
let orderId: string;
let incidentId: string;
beforeAll(async () => {
  w = await createOrdersWorld('t010o');
  const o = await orderFor(w, 'PART_PURCHASE');
  orderId = o.orderId;
  incidentId = o.action.incidentId;
  foreign = await seedTenant(w.db.pool, w.idp, 't010o-beta');
});
afterAll(async () => w?.close());

describe('T-010/T-011 order and job tenant, site and role scope', () => {
  it('every M10 table carries tenant_id, a tenant-leading key and tenant-leading foreign keys', async () => {
    for (const table of M10_TABLES) {
      const col = await w.db.pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(col.rows[0]?.is_nullable, table).toBe('NO');
      const keys = await w.db.pool.query(
        `SELECT conname, contype, (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype IN ('f', 'p', 'u')`,
        [table],
      );
      expect(
        keys.rows.some((k) => k.contype === 'p'),
        table,
      ).toBe(true);
      for (const k of keys.rows) expect(k.first, `${table}.${k.conname}`).toBe('tenant_id');
    }
  });

  it('another tenant cannot read, dispatch, reconcile, verify, revoke or gate an order (same answer as absence)', async () => {
    const fw = await workerService({ ...w, admin: foreign.admin } as never, foreign.admin);
    const missing = 'pur_00000000-0000-0000-0000-000000000000';
    for (const id of [orderId, missing]) {
      for (const p of [
        getOrder(w.db.pool, foreign.admin, id),
        getFulfillmentGate(w.db.pool, foreign.admin, id),
        dispatchOrder(w.db.pool, fw, id, brokerDeps(w)),
        reconcileOrder(w.db.pool, fw, id, brokerDeps(w)),
        recordFulfillmentVerification(w.db.pool, foreign.admin, {
          orderId: id,
          outcome: 'VERIFIED',
          idempotencyKey: 'verify-foreign-1',
        }),
        revokeOrder(w.db.pool, foreign.admin, { orderId: id, reasonCode: 'FOREIGN' }),
        syncIncidentForOrder(w.db.pool, fw, id),
      ])
        expect((await rejection(p)).reasonCode).toBe('RESOURCE_UNAVAILABLE');
    }
    expect((await rejection(listIncidentOrders(w.db.pool, foreign.admin, incidentId))).reasonCode).toBe(
      'RESOURCE_UNAVAILABLE',
    );
    // A foreign worker's poll sweep never sees this tenant's orders.
    const seen: string[] = [];
    await pollFulfillmentStatus(
      w.db.pool,
      fw,
      {
        adapters: new FulfillmentAdapterRegistry([
          {
            providerKey: 't010o-orders',
            adapterClass: 'RECORDED_CONTRACT',
            assess: () => ({ kind: 'ELIGIBLE' }),
            lookup: async (t) => {
              seen.push(t.orderId);
              return { status: 'NOT_FOUND' };
            },
          },
        ]),
      },
      { dueBefore: new Date(Date.now() + 3_600_000).toISOString() },
    );
    expect(seen).toEqual([]);
  });

  it('a foreign authority id cannot be ordered against (IDOR)', async () => {
    const action = await paidActionOf(w, 'PART_PURCHASE');
    const auth = await issue(w, action);
    const fw = await workerService({ ...w, admin: foreign.admin } as never, foreign.admin);
    const r = await rejection(
      requestOrder(
        w.db.pool,
        fw,
        { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: 'order-foreign-1' },
        w.referenceSigner,
      ),
    );
    expect(r.reasonCode).toBe('RESOURCE_UNAVAILABLE');
  });

  it('role matrix: viewers read only; operators request/dispatch/verify; approvers revoke; nobody else', async () => {
    expect((await getOrder(w.db.pool, w.viewerCtx, orderId)).orderId).toBe(orderId);
    const action = await paidActionOf(w, 'PART_PURCHASE');
    const auth = await issue(w, action);
    const req = (ctx: typeof w.viewerCtx) =>
      requestOrder(
        w.db.pool,
        ctx,
        { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: w.key('o') },
        w.referenceSigner,
      );
    expect((await rejection(req(w.viewerCtx))).code).toBe('FORBIDDEN');
    expect((await rejection(dispatchOrder(w.db.pool, w.viewerCtx, orderId, brokerDeps(w)))).code).toBe('FORBIDDEN');
    expect((await rejection(revokeOrder(w.db.pool, w.viewerCtx, { orderId, reasonCode: 'NOPE' }))).code).toBe(
      'FORBIDDEN',
    );
    expect((await rejection(revokeOrder(w.db.pool, w.operator, { orderId, reasonCode: 'NOPE' }))).code).toBe(
      'FORBIDDEN',
    );
    expect(
      (
        await rejection(
          recordFulfillmentVerification(w.db.pool, w.viewerCtx, {
            orderId,
            outcome: 'VERIFIED',
            idempotencyKey: w.key('v'),
          }),
        )
      ).code,
    ).toBe('FORBIDDEN');
    // The approver cannot spoof the engine path that drives incidents.
    expect((await rejection(syncIncidentForOrder(w.db.pool, w.approver, orderId))).code).toBe('FORBIDDEN');
  });
});
