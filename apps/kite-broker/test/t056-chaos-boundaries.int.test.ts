// T-056 chaos restart and recovery — queue, job, callback and CMMS boundaries (NFR-02, NFR-03, INV-16). Faults at the
// outbox publisher (existing afterClaim/beforeAck seams), inside a job's transaction, between a verified provider
// callback's durable delivery record and its job, and inside CMMS ingestion are followed by a restart (a new publisher
// or worker over a healthy pool, or the provider's own redelivery). Proven: every event is delivered at least once and
// applied exactly once, a verified callback is never lost by a crash, no observation or evidence is duplicated, and
// no event is mapped to another tenant.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEventEnvelope } from '@uptimebuyer/contracts';
import { OutboxPublisher, consumeOnce } from '@uptimebuyer/data';
import { ingestFulfillmentWebhook, runFulfillmentObservationJobs } from '@uptimebuyer/orders';
import { ingestCmmsRecord, signCmmsRecord } from '@uptimebuyer/recovery';
import { eventBody, view, webhook } from './m10-helpers.js';
import {
  cmmsRecord,
  createRecoveryWorld,
  verifyingIncident,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';
import { FaultyPool } from './support/faulty-pool.js';

let w: RecoveryWorld;
let v: VerifyingIncident;

beforeAll(async () => {
  w = await createRecoveryWorld('t056b');
  v = await verifyingIncident(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const observations = async (orderId: string) =>
  Number(
    (
      await w.db.pool.query(
        `SELECT count(*)::int AS n FROM fulfillment_observations WHERE purchase_order_id = $1 OR service_job_id = $1`,
        [orderId],
      )
    ).rows[0].n,
  );
const runnableNow = () =>
  w.db.pool.query(
    `UPDATE jobs SET run_after = clock_timestamp() WHERE state = 'PENDING' AND kind = 'orders.fulfillment_observation'`,
  );

describe('T-056 queue boundary: outbox publisher crashes', () => {
  it('publishers killed after claim and before ack lose nothing; the consumer applies each event once', async () => {
    const delivered: DomainEventEnvelope[] = [];
    const applied = new Map<string, number>();
    const sink = {
      async publish(e: DomainEventEnvelope) {
        delivered.push(e);
        await consumeOnce(w.db.pool, 't056-consumer', e, async () => {
          applied.set(e.eventId, (applied.get(e.eventId) ?? 0) + 1);
        });
      },
    };
    const kill = () => {
      throw new Error('publisher killed');
    };
    await expect(
      new OutboxPublisher(w.db.pool, sink, {
        workerId: 't056-a',
        batchSize: 5,
        leaseMs: 200,
        faults: { afterClaim: kill },
      }).runOnce(),
    ).rejects.toThrow();
    let n = 0;
    await expect(
      new OutboxPublisher(w.db.pool, sink, {
        workerId: 't056-b',
        batchSize: 5,
        leaseMs: 200,
        faults: { beforeAck: () => (++n === 2 ? kill() : undefined) },
      }).runOnce(),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    await new OutboxPublisher(w.db.pool, sink, { workerId: 't056-c', batchSize: 200, leaseMs: 5_000 }).drain({
      waitForLeases: true,
      timeoutMs: 60_000,
    });
    const all = await w.db.pool.query(`SELECT id, tenant_id FROM outbox_events`);
    expect(all.rows.length).toBeGreaterThan(10);
    for (const r of all.rows) {
      expect(applied.get(r.id), r.id).toBe(1);
      const e = delivered.find((d) => d.eventId === r.id)!;
      expect(e.tenantId).toBe(r.tenant_id);
    }
    expect(delivered.length).toBeGreaterThanOrEqual(all.rows.length);
  });
});

describe('T-056 job boundary', () => {
  it('a worker killed inside the observation transaction leaves no partial row; the reclaimed job applies once', async () => {
    const order = await view(w, v.orderId);
    const before = await observations(v.orderId);
    const body = eventBody(order, 'delivered');
    expect(
      (
        await ingestFulfillmentWebhook(w.db.pool, webhook(w.account.binding, w.account.verifierKey, body), {
          credentials: w.creds,
        })
      ).status,
    ).toBe('ACCEPTED');
    const fp = new FaultyPool(w.db.pool, [
      { match: /INSERT INTO fulfillment_observations/, phase: 'after', tripAfter: true },
    ]);
    await expect(runFulfillmentObservationJobs(fp.asPool(), { workerId: 't056-dying' })).rejects.toBeDefined();
    expect(await observations(v.orderId)).toBe(before);
    await w.db.pool.query(
      `UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE state = 'RUNNING' AND kind = 'orders.fulfillment_observation'`,
    );
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056-restarted' });
    await runnableNow();
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056-restarted' });
    expect(await observations(v.orderId)).toBe(before + 1);
    const job = await w.db.pool.query(
      `SELECT state FROM jobs WHERE kind = 'orders.fulfillment_observation' AND payload->>'eventId' = $1`,
      [body.eventId],
    );
    expect(job.rows.map((r) => r.state)).toEqual(['SUCCEEDED']);
  });
});

describe('T-056 callback boundary', () => {
  it('a crash after the verified delivery is recorded but before its job exists is recovered by provider redelivery', async () => {
    const order = await view(w, v.orderId);
    const before = await observations(v.orderId);
    const body = eventBody(order, 'delivered');
    const fp = new FaultyPool(w.db.pool, [{ match: /INSERT INTO jobs/, phase: 'before' }]);
    await expect(
      ingestFulfillmentWebhook(fp.asPool(), webhook(w.account.binding, w.account.verifierKey, body), {
        credentials: w.creds,
      }),
    ).rejects.toBeDefined();
    // The provider retries the same event (same event id, fresh signature timestamp).
    const again = await ingestFulfillmentWebhook(w.db.pool, webhook(w.account.binding, w.account.verifierKey, body), {
      credentials: w.creds,
    });
    expect(['ACCEPTED', 'DUPLICATE']).toContain(again.status);
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056-cb' });
    expect(await observations(v.orderId)).toBe(before + 1);
    // A third redelivery after processing changes nothing.
    const third = await ingestFulfillmentWebhook(w.db.pool, webhook(w.account.binding, w.account.verifierKey, body), {
      credentials: w.creds,
    });
    expect(third.status).toBe('DUPLICATE');
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't056-cb' });
    expect(await observations(v.orderId)).toBe(before + 1);
  });

  it('a crash inside CMMS ingestion leaves no evidence; the re-sent record is ingested exactly once', async () => {
    const rec = cmmsRecord(v, Date.now());
    const raw = new Uint8Array(Buffer.from(JSON.stringify(rec), 'utf8'));
    const sign = () => signCmmsRecord(w.cmms.verifierKey, Math.floor(Date.now() / 1000), raw);
    const fp = new FaultyPool(w.db.pool, [
      { match: /INSERT INTO recovery_evidence\b/, phase: 'after', tripAfter: true },
    ]);
    await expect(
      ingestCmmsRecord(
        fp.asPool(),
        w.cmms.ctx,
        { signature: sign(), rawBody: raw },
        { credentials: w.creds },
        w.recoverySigning,
      ),
    ).rejects.toBeDefined();
    const n = async () =>
      Number(
        (
          await w.db.pool.query(
            `SELECT count(*)::int AS n FROM recovery_evidence WHERE tenant_id = $1 AND external_record_id = $2`,
            [w.tenant.tenantId, rec.recordId],
          )
        ).rows[0].n,
      );
    expect(await n()).toBe(0);
    const first = await ingestCmmsRecord(
      w.db.pool,
      w.cmms.ctx,
      { signature: sign(), rawBody: raw },
      { credentials: w.creds },
      w.recoverySigning,
    );
    const second = await ingestCmmsRecord(
      w.db.pool,
      w.cmms.ctx,
      { signature: sign(), rawBody: raw },
      { credentials: w.creds },
      w.recoverySigning,
    );
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(await n()).toBe(1);
    void randomBytes;
  });
});
