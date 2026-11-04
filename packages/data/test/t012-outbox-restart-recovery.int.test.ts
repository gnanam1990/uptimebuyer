// T-012 — Outbox restart recovery (NFR-02, NFR-03 shared layer).
// Domain state and its outbox event commit in one transaction. A publisher killed after the domain commit, one
// killed after claiming, one killed after delivering but before acknowledging, and a real process SIGKILLed while
// holding row locks must not lose or duplicate anything logically: restarted concurrent publishers deliver every
// event at least once and the idempotent consumer applies each exactly once. Jobs recover the same way.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { DomainEventEnvelopeSchema, newId, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OutboxPublisher,
  appendOutboxEvent,
  assignDeviceToAsset,
  claimJobs,
  completeJob,
  consumeOnce,
  createSensorChannel,
  createSite,
  enqueueJob,
  failJob,
  registerAsset,
  registerDevice,
  withTenantTransaction,
  type TenantContext,
} from '../src/index.js';
import {
  createTestDatabase,
  dbScripts,
  seedTenant,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let idp: TestIdentityProvider;
let tenants: SeededTenant[] = [];

interface Fixture {
  ctx: TenantContext;
  deviceId: string;
  assetIds: string[];
}
const fixtures: Fixture[] = [];

class RecordingSink {
  readonly delivered: DomainEventEnvelope[] = [];
  async publish(e: DomainEventEnvelope) {
    this.delivered.push(e);
  }
}

const unpublished = async () =>
  (await db.admin(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`)).rows[0].n as number;

describe('T-012 outbox restart recovery', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t012');
    idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    await db.admin(
      `CREATE TABLE t012_effects (event_id text PRIMARY KEY, tenant_id text NOT NULL, applied int NOT NULL)`,
    );
    tenants = [await seedTenant(db.pool, idp, 'delta'), await seedTenant(db.pool, idp, 'epsilon')];
    for (const t of tenants) {
      const site = await createSite(db.pool, t.admin, { name: 'store', timezone: 'UTC', source: 'API' });
      const assetIds = [];
      for (const serial of ['A', 'B'])
        assetIds.push(
          (
            await registerAsset(db.pool, t.admin, {
              siteId: site.siteId,
              identity: {
                manufacturer: 'M',
                model: 'X',
                serial: `${t.tenantId}-${serial}`,
                safetyClass: 'STANDARD',
                bomRevision: '1',
              },
              source: 'API',
            })
          ).assetId,
        );
      const device = await registerDevice(db.pool, t.admin, {
        siteId: site.siteId,
        credentialRef: `secretref:device/${t.tenantId}`,
        source: 'API',
      });
      fixtures.push({ ctx: t.admin, deviceId: device.deviceId, assetIds });
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('kill between domain commit and publish, then crashed and restarted concurrent publishers: every event once logically', async () => {
    // 1. Domain commands commit their state change and outbox event atomically; the "process" dies before publishing.
    const before = (await db.admin(`SELECT count(*)::int AS n FROM outbox_events`)).rows[0].n as number;
    let commands = 0;
    for (let i = 0; i < 12; i++)
      for (const f of fixtures) {
        await assignDeviceToAsset(db.pool, f.ctx, {
          deviceId: f.deviceId as never,
          assetId: f.assetIds[i % 2] as never,
          source: 'API',
        });
        commands++;
      }
    for (const f of fixtures) {
      await createSensorChannel(db.pool, f.ctx, {
        deviceId: f.deviceId as never,
        kind: 'TEMPERATURE',
        unit: 'MILLI_CELSIUS',
        sourceUnit: 'CELSIUS',
        calibrationRevision: 1,
        calibrationOffsetMilli: 0,
        source: 'API',
      });
      commands++;
    }
    const { rows: allEvents } = await db.admin(
      `SELECT id, tenant_id, aggregate_id, aggregate_version FROM outbox_events ORDER BY seq`,
    );
    expect(allEvents.length - before).toBe(commands);
    expect(await unpublished()).toBe(allEvents.length);
    const assignments = (await db.admin(`SELECT count(*)::int AS n FROM device_asset_assignments`)).rows[0].n;
    expect(assignments).toBe(24);

    const sink = new RecordingSink();
    // 2. Publisher killed right after claiming a batch: its lease stays behind and nothing is published.
    const p1 = new OutboxPublisher(db.pool, sink, {
      workerId: 'p1',
      batchSize: 5,
      leaseMs: 400,
      faults: {
        afterClaim: () => {
          throw new Error('SIMULATED_KILL_AFTER_CLAIM');
        },
      },
    });
    await expect(p1.runOnce()).rejects.toThrow('SIMULATED_KILL_AFTER_CLAIM');
    expect(sink.delivered).toHaveLength(0);
    const leased = (await db.admin(`SELECT count(*)::int AS n FROM outbox_events WHERE lease_owner = 'p1'`)).rows[0].n;
    expect(leased).toBe(5);

    // 3. Publisher killed after the sink accepted events but before acknowledging them.
    let acked = 0;
    const p2 = new OutboxPublisher(db.pool, sink, {
      workerId: 'p2',
      batchSize: 6,
      leaseMs: 400,
      faults: {
        beforeAck: () => {
          if (++acked === 3) throw new Error('SIMULATED_KILL_BEFORE_ACK');
        },
      },
    });
    await expect(p2.runOnce()).rejects.toThrow('SIMULATED_KILL_BEFORE_ACK');
    expect(sink.delivered.length).toBe(3);

    // 4. A real OS process holds row locks mid-claim and is SIGKILLed; live publishers skip its rows meanwhile.
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 't012-killed-publisher.mjs'), db.url, '4'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const line: string = await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('error', reject);
    });
    const { locked } = JSON.parse(line) as { locked: string[] };
    expect(locked).toHaveLength(4);
    const p3 = new OutboxPublisher(db.pool, sink, { workerId: 'p3', batchSize: 100, leaseMs: 400 });
    await p3.runOnce();
    const stillLocked = await db.admin(`SELECT id FROM outbox_events WHERE id = ANY($1) AND published_at IS NULL`, [
      locked,
    ]);
    expect(stillLocked.rows).toHaveLength(4);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // 5. Restart several publishers concurrently; expired leases and released locks are reclaimed.
    const restarted = ['r1', 'r2', 'r3', 'r4'].map(
      (id) => new OutboxPublisher(db.pool, sink, { workerId: id, batchSize: 3, leaseMs: 400 }),
    );
    await Promise.all(restarted.map((p) => p.drain({ waitForLeases: true, timeoutMs: 20_000 })));
    expect(await unpublished()).toBe(0);

    // At-least-once delivery happened (the before-ack crash forced redelivery), with nothing missing.
    const deliveredIds = sink.delivered.map((e) => e.eventId);
    const unique = new Set(deliveredIds);
    expect([...unique].sort()).toEqual(allEvents.map((r) => r.id).sort());
    expect(deliveredIds.length).toBeGreaterThan(unique.size);

    // The idempotent consumer applies each event exactly once, even when fed every physical delivery (twice).
    let duplicates = 0;
    for (const e of [...sink.delivered, ...sink.delivered]) {
      DomainEventEnvelopeSchema.parse(e);
      const r = await consumeOnce(db.pool, 't012-projection', e, async (client, ctx) => {
        expect(ctx.tenantId).toBe(e.tenantId);
        await client.query(
          `INSERT INTO t012_effects (event_id, tenant_id, applied) VALUES ($1, $2, 1)
           ON CONFLICT (event_id) DO UPDATE SET applied = t012_effects.applied + 1`,
          [e.eventId, ctx.tenantId],
        );
      });
      if (r === 'DUPLICATE') duplicates++;
    }
    expect(duplicates).toBe(sink.delivered.length * 2 - unique.size);
    const effects = await db.admin(`SELECT applied, count(*)::int AS n FROM t012_effects GROUP BY applied`);
    expect(effects.rows).toEqual([{ applied: 1, n: unique.size }]);

    // A consumer failure rolls back its receipt, so the event is applied on the next delivery rather than lost.
    const sample = sink.delivered[0]!;
    await expect(
      consumeOnce(db.pool, 't012-flaky', sample, async () => {
        throw new Error('consumer crashed');
      }),
    ).rejects.toThrow('consumer crashed');
    expect(await consumeOnce(db.pool, 't012-flaky', sample, async () => {})).toBe('PROCESSED');

    // Per-aggregate versions are contiguous; no durable domain state went missing.
    const { rows: versions } = await db.admin(
      `SELECT aggregate_id, array_agg(aggregate_version ORDER BY aggregate_version) AS v
         FROM outbox_events WHERE event_type = 'device.asset_assignment_changed.v1' GROUP BY aggregate_id`,
    );
    for (const r of versions as { v: number[] }[]) expect(r.v).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('concurrent healthy publishers physically deliver each event exactly once', async () => {
    const expected: string[] = [];
    for (const f of fixtures)
      await withTenantTransaction(db.pool, f.ctx, async (client) => {
        for (let v = 1; v <= 100; v++)
          expected.push(
            await appendOutboxEvent(client, f.ctx, {
              eventType: 'telemetry.stale.v1',
              aggregateType: 'device',
              aggregateId: f.deviceId,
              aggregateVersion: v,
              payload: { v },
              correlationId: newId('correlation'),
              causationId: newId('command'),
            }),
          );
      });
    const sink = new RecordingSink();
    const pubs = Array.from(
      { length: 6 },
      (_, i) => new OutboxPublisher(db.pool, sink, { workerId: `h${i}`, batchSize: 7, leaseMs: 60_000 }),
    );
    await Promise.all(pubs.map((p) => p.drain()));
    expect(await unpublished()).toBe(0);
    const ids = sink.delivered.map((e) => e.eventId);
    expect(ids.length).toBe(expected.length);
    expect(new Set(ids).size).toBe(expected.length);
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('re-appending the same aggregate version is idempotent; a conflicting payload is rejected', async () => {
    const f = fixtures[0]!;
    const input = {
      eventType: 'telemetry.accepted.v1' as const,
      aggregateType: 'device' as const,
      aggregateId: f.deviceId,
      aggregateVersion: 1,
      payload: { accepted: 3 },
      correlationId: newId('correlation'),
      causationId: newId('command'),
    };
    const first = await withTenantTransaction(db.pool, f.ctx, (c) => appendOutboxEvent(c, f.ctx, input));
    const again = await withTenantTransaction(db.pool, f.ctx, (c) => appendOutboxEvent(c, f.ctx, input));
    expect(again).toBe(first);
    await expect(
      withTenantTransaction(db.pool, f.ctx, (c) => appendOutboxEvent(c, f.ctx, { ...input, payload: { accepted: 4 } })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    // A rolled-back domain transaction leaves no event behind.
    await expect(
      withTenantTransaction(db.pool, f.ctx, async (c) => {
        await appendOutboxEvent(c, f.ctx, { ...input, aggregateVersion: 2 });
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');
    const left = await db.admin(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'telemetry.accepted.v1'`,
      [f.deviceId],
    );
    expect(left.rows[0].n).toBe(1);
    // A forged envelope that names a different tenant than its durable row is refused by the consumer.
    const [row] = (await db.admin(`SELECT id FROM outbox_events WHERE id = $1`, [first])).rows;
    const forged = {
      eventId: row.id,
      eventType: input.eventType,
      occurredAt: new Date().toISOString(),
      tenantId: tenants[1]!.tenantId,
      aggregateType: 'device',
      aggregateId: f.deviceId,
      aggregateVersion: 1,
      correlationId: input.correlationId,
      causationId: input.causationId,
      schemaVersion: 1,
      payload: input.payload,
    } as DomainEventEnvelope;
    await expect(consumeOnce(db.pool, 't012-forged', forged, async () => {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a job whose worker dies is reclaimed after its lease, completed once, and exhausted jobs dead-letter', async () => {
    const f = fixtures[1]!;
    const { jobId } = await withTenantTransaction(db.pool, f.ctx, (c) =>
      enqueueJob(c, f.ctx, { kind: 't012.work', payload: { n: 1 }, dedupeKey: 't012-work-1', maxAttempts: 3 }),
    );
    const dup = await withTenantTransaction(db.pool, f.ctx, (c) =>
      enqueueJob(c, f.ctx, { kind: 't012.work', payload: { n: 1 }, dedupeKey: 't012-work-1', maxAttempts: 3 }),
    );
    expect(dup).toEqual({ jobId, duplicate: true });

    const [w1] = await claimJobs(db.pool, { workerId: 'w1', kinds: ['t012.work'], leaseMs: 300 });
    expect(w1?.job.jobId).toBe(jobId);
    // w1 is killed. While its lease is live nobody else may take the job.
    expect(await claimJobs(db.pool, { workerId: 'w2', kinds: ['t012.work'], leaseMs: 300 })).toEqual([]);
    await sleep(450);
    const [w2] = await claimJobs(db.pool, { workerId: 'w2', kinds: ['t012.work'], leaseMs: 5_000 });
    expect(w2?.job.jobId).toBe(jobId);
    expect(w2?.job.attempts).toBe(2);
    await expect(completeJob(db.pool, w1!)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await completeJob(db.pool, w2!);
    await expect(completeJob(db.pool, w2!)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const state = await db.admin(`SELECT state, attempts FROM jobs WHERE id = $1`, [jobId]);
    expect(state.rows[0]).toEqual({ state: 'SUCCEEDED', attempts: 2 });

    const dead = await withTenantTransaction(db.pool, f.ctx, (c) =>
      enqueueJob(c, f.ctx, { kind: 't012.poison', payload: {}, dedupeKey: 't012-poison', maxAttempts: 2 }),
    );
    for (let i = 0; i < 2; i++) {
      const [c] = await claimJobs(db.pool, { workerId: 'w3', kinds: ['t012.poison'], leaseMs: 5_000 });
      expect(c?.job.jobId).toBe(dead.jobId);
      await failJob(db.pool, c!, { reasonCode: 'POISON', retryInMs: 0 });
    }
    expect(await claimJobs(db.pool, { workerId: 'w3', kinds: ['t012.poison'] })).toEqual([]);
    const deadState = await db.admin(`SELECT state, last_error_code FROM jobs WHERE id = $1`, [dead.jobId]);
    expect(deadState.rows[0]).toEqual({ state: 'DEAD', last_error_code: 'POISON' });
  });
});
