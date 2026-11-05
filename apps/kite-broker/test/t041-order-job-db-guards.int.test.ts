// T-041 — Order and job state progression (database layer). The separate purchase_orders / service_jobs tables refuse
// a state of the other kind, any edge outside their own machine, a state change without an applied observation,
// leaving UNKNOWN on operator say-so, an observation verified under another provider-account revision, and any edit
// of raw provider evidence, transitions, set-once references or change proposals (which can never be auto-accepted).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOrder, ingestFulfillmentWebhook, runFulfillmentObservationJobs } from '@uptimebuyer/orders';
import { brokerDeps, createOrdersWorld, eventBody, orderFor, view, webhook, type OrdersWorld } from './m10-helpers.js';

let w: OrdersWorld;
let purchaseId: string;
let jobId: string;
let observationId: string;
beforeAll(async () => {
  w = await createOrdersWorld('t041');
  const p = await orderFor(w, 'PART_PURCHASE');
  const sent = await dispatchOrder(w.db.pool, w.operator, p.orderId, brokerDeps(w));
  await ingestFulfillmentWebhook(
    w.db.pool,
    webhook(w.account.binding, w.account.verifierKey, eventBody(sent, 'ordered')),
    {
      credentials: w.creds,
    },
  );
  await runFulfillmentObservationJobs(w.db.pool, { workerId: 't041' });
  purchaseId = p.orderId;
  observationId = (await view(w, purchaseId)).observations.at(-1)!.observationId;
  jobId = (await orderFor(w, 'SERVICE_JOB')).orderId;
});
afterAll(async () => w?.close());

const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, [w.tenant.tenantId, ...params]);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('T-041 order and job state progression (database guards)', () => {
  it("each table refuses the other kind's states and illegal edges of its own machine", async () => {
    // The edge guard (UB103) or the per-table state CHECK (23514) refuses a cross-kind state.
    expect(['UB103', '23514']).toContain(
      await code(
        q(`UPDATE purchase_orders SET state = 'SCHEDULED', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [
          purchaseId,
        ]),
      ),
    );
    expect(['UB103', '23514']).toContain(
      await code(
        q(`UPDATE service_jobs SET state = 'SHIPPED', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [jobId]),
      ),
    );
    // Inserting an observation that claims a service state for a purchase order violates the per-kind CHECK.
    const r = (
      await q(
        `SELECT provider_account_id, provider_account_revision_id FROM purchase_orders WHERE tenant_id = $1 AND id = $2`,
        [purchaseId],
      )
    ).rows[0];
    expect(
      await code(
        q(
          `INSERT INTO fulfillment_observations (tenant_id, id, order_kind, purchase_order_id, provider_account_id,
             provider_account_revision_id, source, provider_event_key, raw_status, normalized_state, observed_at,
             disposition, actor_kind, actor_id)
           VALUES ($1, 'fob_' || gen_random_uuid(), 'PURCHASE_ORDER', $2, $3, $4, 'POLL', 'poll:cross-kind', 'scheduled',
                   'SCHEDULED', clock_timestamp(), 'APPLIED', 'WORKER', 'x')`,
          [purchaseId, r.provider_account_id, r.provider_account_revision_id],
        ),
      ),
    ).toBe('23514');
    // ORDERED -> DELIVERED is not an edge, even with a matching applied observation id.
    expect(
      await code(
        q(
          `UPDATE purchase_orders SET state = 'DELIVERED', version = version + 1, last_observation_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [purchaseId, observationId],
        ),
      ),
    ).toBe('UB103');
  });

  it('a state change needs a new applied observation for that state; UNKNOWN never leaves on operator say-so', async () => {
    expect(
      await code(
        q(`UPDATE purchase_orders SET state = 'SHIPPED', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [
          purchaseId,
        ]),
      ),
    ).toBe('UB103');
    expect(
      await code(
        q(
          `UPDATE purchase_orders SET state = 'SHIPPED', version = version + 1, last_observation_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [purchaseId, observationId],
        ),
      ),
    ).toBe('UB103');
  });

  it('raw provider evidence, transitions and change proposals are immutable', async () => {
    expect(
      await code(
        q(`UPDATE fulfillment_observations SET raw_status = 'delivered' WHERE tenant_id = $1 AND id = $2`, [
          observationId,
        ]),
      ),
    ).toBe('UB001');
    expect(
      await code(q(`DELETE FROM fulfillment_observations WHERE tenant_id = $1 AND id = $2`, [observationId])),
    ).toBe('UB001');
    expect(
      await code(
        q(
          `UPDATE purchase_order_transitions SET to_state = 'DELIVERED' WHERE tenant_id = $1 AND purchase_order_id = $2`,
          [purchaseId],
        ),
      ),
    ).toBe('UB001');
    expect(await code(q(`DELETE FROM purchase_orders WHERE tenant_id = $1 AND id = $2`, [purchaseId]))).toBe('UB001');
    expect(
      await code(
        q(
          `INSERT INTO fulfillment_change_proposals (tenant_id, id, order_kind, purchase_order_id, observation_id, change_kind,
             approved, proposed, requires_reentry, auto_accepted, actor_kind, actor_id)
           VALUES ($1, 'fcp_' || gen_random_uuid(), 'PURCHASE_ORDER', $2, $3, 'SUBSTITUTION', '{}', '{}', ARRAY['APPROVAL'], true, 'WORKER', 'x')`,
          [purchaseId, observationId],
        ),
      ),
    ).toBe('23514');
  });

  it('identity and set-once evidence cannot change; an observation cannot attach under another revision', async () => {
    expect(
      await code(
        q(
          `UPDATE purchase_orders SET action_digest = 'action.v1:sha256:${'0'.repeat(64)}', version = version + 1 WHERE tenant_id = $1 AND id = $2`,
          [purchaseId],
        ),
      ),
    ).toBe('UB001');
    expect(
      await code(
        q(
          `UPDATE purchase_orders SET provider_ref = 'other-ref', version = version + 1 WHERE tenant_id = $1 AND id = $2`,
          [purchaseId],
        ),
      ),
    ).toBe('UB104');
    const r = (await q(`SELECT * FROM fulfillment_observations WHERE tenant_id = $1 AND id = $2`, [observationId]))
      .rows[0];
    const other = (
      await q(`SELECT id FROM provider_account_revisions WHERE tenant_id = $1 AND id <> $2 LIMIT 1`, [
        r.provider_account_revision_id,
      ])
    ).rows[0].id;
    expect(
      await code(
        q(
          `INSERT INTO fulfillment_observations (tenant_id, id, order_kind, purchase_order_id, provider_account_id,
             provider_account_revision_id, source, provider_event_key, raw_status, normalized_state, observed_at,
             disposition, actor_kind, actor_id)
           VALUES ($1, 'fob_' || gen_random_uuid(), 'PURCHASE_ORDER', $2, $3, $4, 'POLL', 'poll:forged', 'shipped', 'SHIPPED',
                   clock_timestamp(), 'APPLIED', 'WORKER', 'x')`,
          [purchaseId, r.provider_account_id, other],
        ),
      ),
    ).toBe('23503');
  });
});
