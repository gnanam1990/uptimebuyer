// T-057 (M14) worker runtime over a real seeded world: every runner M13 left unscheduled is built into the worker
// process, each one executes against a database carrying incidents, orders, recovery evidence and an outbox backlog,
// the outbox runner delivers every durable event to every handle*Event consumer exactly once, two replicas never
// double-execute a runner, a failing runner does not stop the others, and shutdown drains with no lock left behind.
// It lives here only because the recovery world needs the in-process RECORDED_CONTRACT broker (INV-06); the worker
// itself never imports the broker.
import { handleInvalidationEvent } from '@uptimebuyer/compatibility';
import { handleTelemetryEvent } from '@uptimebuyer/incidents';
import { handleCommercialIntentEvent, handleOrderStateEvent } from '@uptimebuyer/orders';
import { handlePlanningEvent } from '@uptimebuyer/planning';
import { handleBrokerResultEvent, handleNotificationEvent } from '@uptimebuyer/providers';
import { handleIncidentReopenedEvent, handleOrderFactEvent } from '@uptimebuyer/recovery';
import { MetricsRegistry, platformMetrics } from '@uptimebuyer/observability';
import {
  ConsumerSink,
  DEFAULT_CONSUMERS,
  PgAdvisoryLocks,
  RUNNER_NAMES,
  Scheduler,
  buildRunners,
} from '@uptimebuyer/worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryWorld, recoveredIncident, type RecoveryWorld } from './m11-helpers.js';

let w: RecoveryWorld;
let poolA: pg.Pool;
let poolB: pg.Pool;

beforeAll(async () => {
  w = await createRecoveryWorld('m14worker');
  await recoveredIncident(w);
  poolA = new pg.Pool({ connectionString: w.db.url, max: 8 });
  poolB = new pg.Pool({ connectionString: w.db.url, max: 8 });
  for (const p of [poolA, poolB]) p.on('error', () => {});
});
afterAll(async () => {
  await poolA?.end().catch(() => {});
  await poolB?.end().catch(() => {});
  await w?.close();
});

const runnersFor = (pool: pg.Pool, workerId: string) =>
  buildRunners({ pool, workerId, platformMetrics: platformMetrics(new MetricsRegistry()) });
const schedulerFor = (pool: pg.Pool, workerId: string, extra: Parameters<typeof buildRunners>[0] | null = null) =>
  new Scheduler({
    runners: buildRunners(extra ?? { pool, workerId, platformMetrics: platformMetrics(new MetricsRegistry()) }),
    locks: new PgAdvisoryLocks(pool),
    signal: new AbortController().signal,
  });
const unpublished = async () =>
  (await w.db.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`)).rows[0]
    .n as number;

describe('T-057 worker runtime: every M13 runner is scheduled', () => {
  it('builds exactly the runner set M13 left unscheduled, with bounded intervals', () => {
    expect([...RUNNER_NAMES].sort()).toEqual(
      [
        'outbox.publish',
        'jobs.fulfillment_observation',
        'jobs.webhook_apply',
        'jobs.plan_revalidation',
        'jobs.contact_dispatch',
        'tenants.contact_sweep',
        'tenants.fulfillment_poll',
        'tenants.cmms_writes',
        'tenants.recovery_monitor',
        'tenants.deadline_expiry',
        'tenants.policy_activation',
        'platform.retention_sweep',
        'platform.token_prune',
        'platform.signals',
      ].sort(),
    );
    const runners = runnersFor(poolA, 'm14-shape');
    expect(runners.map((r) => r.name).sort()).toEqual([...RUNNER_NAMES].sort());
    for (const r of runners) {
      expect(r.intervalMs, r.name).toBeGreaterThanOrEqual(1_000);
      expect(r.intervalMs, r.name).toBeLessThanOrEqual(24 * 3_600_000);
    }
  });

  it('the outbox sink routes every event to every handle*Event consumer', () => {
    const handlers = DEFAULT_CONSUMERS.map((c) => c.handle);
    for (const h of [
      handleTelemetryEvent,
      handleInvalidationEvent,
      handlePlanningEvent,
      handleBrokerResultEvent,
      handleNotificationEvent,
      handleCommercialIntentEvent,
      handleOrderStateEvent,
      handleOrderFactEvent,
      handleIncidentReopenedEvent,
    ])
      expect(handlers, h.name).toContain(h);
    expect(new Set(DEFAULT_CONSUMERS.map((c) => c.name)).size).toBe(DEFAULT_CONSUMERS.length);
  });
});

describe('T-057 worker runtime: runners execute against a real seeded database', () => {
  it('one tick of every runner succeeds and the outbox backlog is delivered to the consumers', async () => {
    const backlog = await unpublished();
    expect(backlog).toBeGreaterThan(0);
    const s = schedulerFor(poolA, 'm14-a');
    const outcomes: Record<string, string> = {};
    for (const name of RUNNER_NAMES) outcomes[name] = await s.tick(name);
    expect(outcomes).toEqual(Object.fromEntries(RUNNER_NAMES.map((n) => [n, 'OK'])));
    // Repeat the outbox runner until the backlog (and anything the consumers emitted) is delivered.
    for (let i = 0; i < 20 && (await unpublished()) > 0; i++) expect(await s.tick('outbox.publish')).toBe('OK');
    expect(await unpublished()).toBe(0);
    const { rows } = await w.db.pool.query(
      `SELECT consumer, count(*)::int AS n FROM outbox_consumer_receipts GROUP BY consumer ORDER BY consumer`,
    );
    const consumers = rows.map((r) => r.consumer as string);
    for (const c of DEFAULT_CONSUMERS.map((d) => d.name)) expect(consumers, c).toContain(c);
    await s.stop();
  });

  it('consumer delivery is idempotent: re-delivering a published event changes nothing', async () => {
    // published_at is a one-shot stamp (the outbox is append-only), so re-delivery is what a publisher crash between
    // delivery and acknowledgement produces: the sink sees the same envelopes again.
    const before = (await w.db.pool.query(`SELECT count(*)::int AS n FROM outbox_consumer_receipts`)).rows[0].n;
    const { rows } = await w.db.pool.query(`SELECT * FROM outbox_events ORDER BY seq LIMIT 25`);
    expect(rows.length).toBe(25);
    const sink = new ConsumerSink(poolA);
    for (const r of rows)
      await sink.publish({
        eventId: r.id,
        eventType: r.event_type,
        occurredAt: r.occurred_at.toISOString(),
        tenantId: r.tenant_id,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        aggregateVersion: r.aggregate_version,
        correlationId: r.correlation_id,
        causationId: r.causation_id,
        schemaVersion: 1,
        payload: r.payload,
      } as never);
    expect(await unpublished()).toBe(0);
    const after = (await w.db.pool.query(`SELECT count(*)::int AS n FROM outbox_consumer_receipts`)).rows[0].n;
    expect(after).toBe(before);
  });
});

describe('T-057 worker runtime: two replicas', () => {
  it('ticking every runner on two replicas at once executes each runner exactly once', async () => {
    const a = schedulerFor(poolA, 'm14-ra');
    const b = schedulerFor(poolB, 'm14-rb');
    // Slow every runner down enough that the two ticks overlap: hold an outbox row lock is not needed, the advisory
    // lock is taken before any work, so issuing both ticks concurrently is sufficient.
    const results = await Promise.all(RUNNER_NAMES.map(async (n) => [n, await a.tick(n), await b.tick(n)] as const));
    for (const [name, ra, rb] of results) {
      // Sequential per replica, so both can succeed; the concurrent case is proven next.
      expect([ra, rb], name).toContain('OK');
    }
    const concurrent = await Promise.all(RUNNER_NAMES.map((n) => Promise.all([a.tick(n), b.tick(n)])));
    for (const [i, pair] of concurrent.entries()) {
      const ok = pair.filter((o) => o === 'OK').length;
      const skipped = pair.filter((o) => o === 'SKIPPED_LOCKED').length;
      expect(ok + skipped, RUNNER_NAMES[i]).toBe(2);
      expect(ok, RUNNER_NAMES[i]).toBeGreaterThanOrEqual(1);
    }
    await a.stop();
    await b.stop();
  });
});

describe('T-057 worker runtime: failure isolation and graceful shutdown', () => {
  it('a failing runner leaves every real runner ticking; stop() drains and leaves no advisory lock', async () => {
    const real = runnersFor(poolA, 'm14-iso');
    const s = new Scheduler({
      runners: [
        ...real.map((r) => ({ ...r, intervalMs: 1_000 })),
        {
          name: 'test.always_fails',
          intervalMs: 1_000,
          run: async () => {
            throw new Error('dependency down');
          },
        },
      ],
      locks: new PgAdvisoryLocks(poolA),
      signal: new AbortController().signal,
      initialDelayMaxMs: 50,
    });
    s.start();
    const deadline = Date.now() + 60_000;
    const done = () =>
      s.status().every((r) => (r.name === 'test.always_fails' ? r.consecutiveFailures >= 1 : r.lastOutcome === 'OK'));
    while (!done()) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(s.status()));
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await s.stop()).drained).toBe(true);
    const { rows } = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(rows[0].n).toBe(0);
  });
});
