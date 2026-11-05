// M10 self security review regressions (T-043 / T-044 / T-042 scope).
// F1 lock order: requestOrder must take the planning lock BEFORE it locks any commercial-intent row, the same order as
//    the broker linearization and revokeOrder, or a successor request and a revocation of a lagging predecessor can
//    deadlock (each holding what the other needs).
// F2 fail-open drift: a provider observation for an order whose intent was never handed to the broker (no attempt,
//    nothing could have been sent) must not move it (a signed "accepted" cannot fabricate provider acceptance).
// F3 cross-order mapping: a provider reference already bound to another order of the account is refused, never
//    adopted (no unique-violation crash loop, no polling of the other order's status under this order).
// F4 idempotency: reusing a verification idempotency key for a different outcome is IDEMPOTENCY_KEY_REUSED.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dispatchOrder,
  ingestFulfillmentWebhook,
  recordFulfillmentVerification,
  requestOrder,
  revokeOrder,
  runFulfillmentObservationJobs,
} from '@uptimebuyer/orders';
import { freshApproval, intentRef, issue, rejection, sessionRef } from './helpers.js';
import { brokerDeps, createOrdersWorld, eventBody, orderFor, view, webhook, type OrdersWorld } from './m10-helpers.js';

let w: OrdersWorld;
beforeAll(async () => {
  w = await createOrdersWorld('m10sec');
});
afterAll(async () => w?.close());

const ingest = (req: ReturnType<typeof webhook>) => ingestFulfillmentWebhook(w.db.pool, req, { credentials: w.creds });
const apply = () => runFulfillmentObservationJobs(w.db.pool, { workerId: 'm10-sec' });

describe('M10 security review regressions', () => {
  it('F1: requestOrder takes the planning lock before locking any intent row', async () => {
    const first = await orderFor(w, 'PART_PURCHASE');
    await revokeOrder(w.db.pool, w.approver, { orderId: first.orderId, reasonCode: 'OPERATOR_CANCELLED' });
    // The broker fails the intent (definite no effect) but the order mirror lags (crash before mirroring).
    await w.broker.execute(intentRef(w, first.out.order.commercialIntentId));
    expect((await view(w, first.orderId)).noEffectProven).toBe(false);
    const approvalId = await freshApproval(w, first.action);
    const auth = await issue(w, first.action, approvalId);
    await w.broker.activateSession(sessionRef(w, auth.authority.executionAuthorityId));

    const holder = new pg.Client({ connectionString: w.db.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `planning:${w.tenant.tenantId}:${first.action.incidentId}`,
      ]);
      const pending = requestOrder(
        w.db.pool,
        w.operator,
        { executionAuthorityId: auth.authority.executionAuthorityId, idempotencyKey: w.key('succ') },
        w.referenceSigner,
      );
      await new Promise((r) => setTimeout(r, 400));
      // A revocation/linearization holding the planning lock must still be able to lock the predecessor's intent.
      const probe = await holder
        .query(`SELECT id FROM commercial_intents WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE NOWAIT`, [
          w.tenant.tenantId,
          first.out.order.commercialIntentId,
        ])
        .then(
          () => 'LOCKED',
          (e: { code?: string }) => e.code,
        );
      await holder.query('ROLLBACK');
      expect(probe).toBe('LOCKED');
      const succ = await pending;
      expect(succ.order.supersedesOrderId).toBe(first.orderId);
    } finally {
      await holder.end().catch(() => {});
    }
  });

  it('F2: a provider observation before any possible egress does not move the order', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    expect(
      (await ingest(webhook(w.account.binding, w.account.verifierKey, eventBody(o.out.order, 'accepted')))).status,
    ).toBe('ACCEPTED');
    await apply();
    const v = await view(w, o.orderId);
    expect(v.state).toBe('REQUESTED');
    expect(v.observations.map((x) => x.disposition)).toEqual(['REFUSED']);
  });

  it('F3: a provider reference already bound to another order is refused, not adopted', async () => {
    const a = await orderFor(w, 'PART_PURCHASE');
    const sentA = await dispatchOrder(w.db.pool, w.operator, a.orderId, brokerDeps(w));
    expect(sentA.providerRef).not.toBeNull();
    const b = await orderFor(w, 'PART_PURCHASE');
    w.adapter.nextModes.push('DROP_RESPONSE');
    const sentB = await dispatchOrder(w.db.pool, w.operator, b.orderId, brokerDeps(w));
    expect(sentB.providerRef).toBeNull();
    await ingest(
      webhook(
        w.account.binding,
        w.account.verifierKey,
        eventBody(sentB, 'ordered', { providerRef: sentA.providerRef }),
      ),
    );
    await apply();
    const vb = await view(w, b.orderId);
    expect([vb.state, vb.providerRef]).toEqual(['UNKNOWN', null]);
    expect(vb.observations.some((x) => x.disposition === 'REFUSED' && x.reasonCode === 'PROVIDER_REF_CONFLICT')).toBe(
      true,
    );
    const dead = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'orders.fulfillment_observation' AND state <> 'SUCCEEDED'`,
      [w.tenant.tenantId],
    );
    expect(dead.rows[0].n).toBe(0);
  });

  it('F4: reusing a verification idempotency key for a different outcome is refused', async () => {
    const o = await orderFor(w, 'PART_PURCHASE');
    const sent = await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    for (const s of ['ordered', 'shipped', 'delivered'])
      await ingest(webhook(w.account.binding, w.account.verifierKey, eventBody(sent, s)));
    await apply();
    const key = w.key('verify');
    expect(
      (
        await recordFulfillmentVerification(w.db.pool, w.operator, {
          orderId: o.orderId,
          outcome: 'VERIFIED',
          idempotencyKey: key,
        })
      ).state,
    ).toBe('VERIFIED');
    expect(
      (
        await recordFulfillmentVerification(w.db.pool, w.operator, {
          orderId: o.orderId,
          outcome: 'VERIFIED',
          idempotencyKey: key,
        })
      ).state,
    ).toBe('VERIFIED');
    const r = await rejection(
      recordFulfillmentVerification(w.db.pool, w.operator, {
        orderId: o.orderId,
        outcome: 'DISPUTED',
        idempotencyKey: key,
      }),
    );
    expect(r.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
