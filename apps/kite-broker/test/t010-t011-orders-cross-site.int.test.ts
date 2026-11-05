// T-010 / T-011 cross-site sweep over every human-callable M10 command and query (INV-16, FR-24). Members of another
// site of the SAME tenant (operator, maintenance approver) are refused on every order/job read and write path, and a
// refused call writes nothing. Engine-only entry points (incident sync, polling) refuse human principals outright;
// webhook ingress takes no principal and resolves the tenant only from its binding (T-043).
// Security review finding (coordinator, MEDIUM): mirrorOrder locked, mirrored and returned the full order view without
// authorizing against the order's site.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@uptimebuyer/data';
import {
  FulfillmentAdapterRegistry,
  dispatchOrder,
  getFulfillmentGate,
  getOrder,
  listIncidentOrders,
  pollFulfillmentStatus,
  reconcileOrder,
  recordFulfillmentVerification,
  requestOrder,
  revokeOrder,
  syncIncidentForOrder,
} from '@uptimebuyer/orders';
import { mirrorOrder } from '../../../packages/orders/src/dispatch.js';
import { person } from '../../../packages/compatibility/test/helpers.js';
import { intentRef, issue, rejection, rowOf } from './helpers.js';
import { brokerDeps, createOrdersWorld, orderFor, paidActionOf, view, type OrdersWorld } from './m10-helpers.js';

let w: OrdersWorld;
let farOperator: TenantContext;
let farApprover: TenantContext;
beforeAll(async () => {
  w = await createOrdersWorld('t010x');
  farOperator = (await person(w, 'far-operator', ['operator'], w.otherSiteId as never)).ctx;
  farApprover = (await person(w, 'far-approver', ['maintenance_approver', 'finance_approver'], w.otherSiteId as never))
    .ctx;
});
afterAll(async () => w?.close());

const snapshot = async (orderId: string) => {
  const r = await rowOf(w, orderId.startsWith('pur_') ? 'purchase_orders' : 'service_jobs', orderId);
  const obs = await w.db.pool.query(
    `SELECT count(*)::int AS n FROM fulfillment_observations WHERE tenant_id = $1
        AND coalesce(purchase_order_id, service_job_id) = $2`,
    [w.tenant.tenantId, orderId],
  );
  return { version: r.version, state: r.state, cancel: r.cancel_requested_at, observations: obs.rows[0].n };
};

describe('T-010/T-011 cross-site order and job scope', () => {
  it('mirrorOrder refuses a member of another site and writes nothing', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    // The broker settles the intent; the order mirror lags, so an unauthorized mirror WOULD write.
    await w.broker.execute(intentRef(w, o.out.order.commercialIntentId));
    const before = await snapshot(o.orderId);
    expect(before.state).toBe('REQUESTED');
    const r = await rejection(mirrorOrder(w.db.pool, farOperator, o.orderId));
    expect(r.code).toBe('FORBIDDEN');
    expect(await snapshot(o.orderId)).toEqual(before);
    // The authorized site member can mirror it.
    expect((await mirrorOrder(w.db.pool, w.operator, o.orderId)).state).toBe('ACCEPTED');
  });

  it('every other order/job read and command refuses another site and writes nothing', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    const sent = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    const before = await snapshot(o.orderId);
    const calls: [string, () => Promise<unknown>][] = [
      ['getOrder', () => getOrder(w.db.pool, farOperator, o.orderId)],
      ['getFulfillmentGate', () => getFulfillmentGate(w.db.pool, farOperator, o.orderId)],
      ['listIncidentOrders', () => listIncidentOrders(w.db.pool, farOperator, sent.incidentId)],
      ['dispatchOrder', () => dispatchOrder(w.db.pool, farOperator, o.orderId, brokerDeps(w))],
      ['reconcileOrder', () => reconcileOrder(w.db.pool, farOperator, o.orderId, brokerDeps(w))],
      [
        'recordFulfillmentVerification',
        () =>
          recordFulfillmentVerification(w.db.pool, farOperator, {
            orderId: o.orderId,
            outcome: 'DISPUTED',
            idempotencyKey: w.key('x-verify'),
          }),
      ],
      ['revokeOrder', () => revokeOrder(w.db.pool, farApprover, { orderId: o.orderId, reasonCode: 'CROSS_SITE' })],
      ['syncIncidentForOrder', () => syncIncidentForOrder(w.db.pool, farOperator, o.orderId)],
      [
        'pollFulfillmentStatus',
        () => pollFulfillmentStatus(w.db.pool, farOperator, { adapters: new FulfillmentAdapterRegistry([]) }, {}),
      ],
    ];
    for (const [name, call] of calls) expect((await rejection(call())).code, name).toBe('FORBIDDEN');
    expect(await snapshot(o.orderId)).toEqual(before);
    expect((await rowOf(w, 'execution_authorities', o.auth.authority.executionAuthorityId)).status).toBe('ACTIVE');
    expect((await view(w, o.orderId)).state).toBe('ACCEPTED');
  });

  it('requestOrder refuses an authority of another site and creates nothing', async () => {
    const action = await paidActionOf(w, 'SERVICE_JOB');
    const auth = await issue(w, action);
    const r = await rejection(
      requestOrder(
        w.db.pool,
        farOperator,
        { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: w.key('x-order') },
        w.referenceSigner,
      ),
    );
    expect(r.code).toBe('FORBIDDEN');
    const n = await w.db.pool.query(
      `SELECT (SELECT count(*) FROM commercial_intents WHERE tenant_id = $1 AND execution_authority_id = $2)::int
            + (SELECT count(*) FROM service_jobs WHERE tenant_id = $1 AND execution_authority_id = $2)::int AS n`,
      [w.tenant.tenantId, auth.authority.executionAuthorityId],
    );
    expect(n.rows[0].n).toBe(0);
  });
});
