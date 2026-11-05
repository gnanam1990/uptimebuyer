// M13 security review findings on the provider-callback boundary (each added red before its fix).
// S8 — the orphan-recovery path treated every verified delivery with processed_at NULL, a matching digest and no job
// as a crashed delivery to re-process, and quarantine left the delivery open: a replay of a quarantined body was
// re-evaluated (and could be processed if the quarantine condition later changed). Quarantine is now terminal on the
// delivery row, the delivery and its job (or its quarantine) are written in one transaction, so the orphan path covers
// only deliveries left by a crash before this fix; concurrent replays produce at most one job.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOrder, ingestFulfillmentWebhook, runFulfillmentObservationJobs } from '@uptimebuyer/orders';
import { brokerDeps, createOrdersWorld, eventBody, orderFor, view, webhook, type OrdersWorld } from './m10-helpers.js';

let w: OrdersWorld;
let orderId: string;

beforeAll(async () => {
  w = await createOrdersWorld('t056sr');
  const o = await orderFor(w, 'PART_PURCHASE');
  await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
  orderId = o.orderId;
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const q = (sql: string, params: unknown[]) => w.db.pool.query(sql, params);
const ingest = (body: Record<string, unknown>) =>
  ingestFulfillmentWebhook(w.db.pool, webhook(w.account.binding, w.account.verifierKey, body), {
    credentials: w.creds,
  });

describe('M13 security review S8: quarantine is terminal and replays never reopen it', () => {
  it('a replayed quarantined delivery stays quarantined: no job, no re-evaluation', async () => {
    const order = await view(w, orderId);
    // A verified event for a client operation this account never issued: quarantined (TARGET_NOT_FOUND).
    const body = eventBody({ ...order, clientOperationId: `op_${randomUUID()}` } as never, 'shipped');
    const first = await ingest(body);
    expect(first).toMatchObject({ status: 'QUARANTINED', reasonCode: 'TARGET_NOT_FOUND' });
    const deliveryId = (first as { deliveryId: string }).deliveryId;
    const delivery = (await q(`SELECT processed_at FROM webhook_deliveries WHERE id = $1`, [deliveryId])).rows[0];
    expect(delivery.processed_at).not.toBeNull();
    const replay = await ingest(body);
    expect(['DUPLICATE', 'QUARANTINED']).toContain(replay.status);
    const jobs = await q(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`fulfillment:${deliveryId}`]);
    expect(jobs.rowCount).toBe(0);
    const audits = await q(
      `SELECT 1 FROM audit_entries WHERE action = 'orders.fulfillment_webhook' AND resource_id = $1`,
      [deliveryId],
    );
    expect(audits.rowCount).toBe(1);
  });

  it('a delivery left without its job by a crash (before this fix) is recovered exactly once', async () => {
    const order = await view(w, orderId);
    const body = eventBody(order, 'ordered');
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(raw.toString('latin1')).digest('hex')}`;
    // The row a crash between the two writes left behind: verified, unprocessed, no job.
    const rev = (
      await q(`SELECT provider_account_id, id FROM provider_account_revisions WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        w.account.revisionId,
      ])
    ).rows[0];
    const orphan = `whd_${randomBytes(8).toString('hex')}`;
    await q(
      `INSERT INTO webhook_deliveries (tenant_id, id, provider_account_id, provider_account_revision_id, provider_event_id,
         signature_result, body_digest)
       VALUES ($1, $2, $3, $4, $5, 'VALID', $6)`,
      [w.tenant.tenantId, orphan, rev.provider_account_id, rev.id, body.eventId, digest],
    );
    const before = (await view(w, orderId)).observations.length;
    const again = await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(w.account.binding, w.account.verifierKey, {}, { raw: new Uint8Array(raw) }),
      { credentials: w.creds },
    );
    expect(['ACCEPTED', 'DUPLICATE']).toContain(again.status);
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056sr' });
    expect((await view(w, orderId)).observations.length).toBe(before + 1);
    await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(w.account.binding, w.account.verifierKey, {}, { raw: new Uint8Array(raw) }),
      {
        credentials: w.creds,
      },
    );
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056sr' });
    expect((await view(w, orderId)).observations.length).toBe(before + 1);
    expect((await q(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`fulfillment:${orphan}`])).rowCount).toBe(1);
  });

  it('concurrent identical replays create at most one delivery and one job', async () => {
    const order = await view(w, orderId);
    const body = eventBody(order, 'shipped');
    const results = await Promise.all(Array.from({ length: 6 }, () => ingest(body)));
    expect(results.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
    const d = await q(
      `SELECT id FROM webhook_deliveries WHERE tenant_id = $1 AND provider_event_id = $2 AND signature_result = 'VALID'`,
      [w.tenant.tenantId, body.eventId],
    );
    expect(d.rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`fulfillment:${d.rows[0].id}`])).rowCount).toBe(1);
  });
});
