// T-057 (M14) worker scheduling, database layer: the PostgreSQL advisory-lock provider. Two worker replicas (two
// schedulers, two pools) ticking the same runner at the same moment execute it exactly once; the lock is released
// on completion, on failure and on shutdown; a replica whose connection dies loses the lock so another can take over.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/data/test/helpers.js';
import { PgAdvisoryLocks, Scheduler, type RunnerSpec } from '../src/scheduler.js';

let db: TestDatabase;
let poolA: pg.Pool;
let poolB: pg.Pool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createTestDatabase('m14locks');
  poolA = new pg.Pool({ connectionString: db.url, max: 4 });
  poolB = new pg.Pool({ connectionString: db.url, max: 4 });
  for (const p of [poolA, poolB]) p.on('error', () => {});
});
afterAll(async () => {
  await poolA.end().catch(() => {});
  await poolB.end().catch(() => {});
  await db.drop();
});

const replica = (pool: pg.Pool, runners: RunnerSpec[]) =>
  new Scheduler({ runners, locks: new PgAdvisoryLocks(pool), signal: new AbortController().signal, minIntervalMs: 10 });

describe('T-057 worker scheduling: PostgreSQL advisory lock per runner', () => {
  it('one tick from two replicas executes the runner exactly once', async () => {
    let executions = 0;
    const spec = (): RunnerSpec => ({
      name: 'test.once',
      intervalMs: 1_000,
      run: async () => {
        executions++;
        await sleep(300);
      },
    });
    const a = replica(poolA, [spec()]);
    const b = replica(poolB, [spec()]);
    for (let round = 0; round < 3; round++) {
      const before = executions;
      const outcomes = await Promise.all([a.tick('test.once'), b.tick('test.once')]);
      expect(outcomes.sort()).toEqual(['OK', 'SKIPPED_LOCKED']);
      expect(executions - before).toBe(1);
    }
    await a.stop();
    await b.stop();
  });

  it('different runners do not block each other', async () => {
    const ran: string[] = [];
    const mk = (name: string): RunnerSpec => ({
      name,
      intervalMs: 1_000,
      run: async () => {
        ran.push(name);
        await sleep(100);
      },
    });
    const a = replica(poolA, [mk('test.left')]);
    const b = replica(poolB, [mk('test.right')]);
    expect(await Promise.all([a.tick('test.left'), b.tick('test.right')])).toEqual(['OK', 'OK']);
    expect(ran.sort()).toEqual(['test.left', 'test.right']);
    await a.stop();
    await b.stop();
  });

  it('the lock is released after a failing run and no advisory lock is left behind', async () => {
    const a = replica(poolA, [
      {
        name: 'test.fails',
        intervalMs: 1_000,
        run: async () => {
          throw new Error('boom');
        },
      },
    ]);
    const b = replica(poolB, [{ name: 'test.fails', intervalMs: 1_000, run: async () => {} }]);
    expect(await a.tick('test.fails')).toBe('FAILED');
    expect(await b.tick('test.fails')).toBe('OK');
    const { rows } = await db.admin(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database =
         (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(rows[0].n).toBe(0);
    await a.stop();
    await b.stop();
  });

  it('a replica whose database session dies mid-run loses the lock; the other replica takes the next tick', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    const a = replica(poolA, [
      {
        name: 'test.crash',
        intervalMs: 1_000,
        run: async (signal) => {
          started();
          await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
        },
      },
    ]);
    const b = replica(poolB, [{ name: 'test.crash', intervalMs: 1_000, run: async () => {} }]);
    const inflight = a.tick('test.crash');
    await begun;
    expect(await b.tick('test.crash')).toBe('SKIPPED_LOCKED');
    // Kill the session holding the lock (a crashed replica): PostgreSQL drops session advisory locks with it.
    await db.admin(
      `SELECT pg_terminate_backend(l.pid) FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    await sleep(100);
    expect(await b.tick('test.crash')).toBe('OK');
    await a.stop();
    await inflight.catch(() => {});
    await b.stop();
  });
});
