// T-057 (M14) worker scheduling, unit layer: bounded jittered intervals, per-runner locking through the lock port,
// failure isolation between runners, tick timeouts, graceful shutdown bound to a root AbortSignal, and closed-label
// metrics. The PostgreSQL advisory-lock provider and the real runner set are proven in the integration tests.
import { MetricsRegistry } from '@uptimebuyer/observability';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Scheduler,
  jitteredDelay,
  workerMetrics,
  type LockProvider,
  type RunnerSpec,
  type TickOutcome,
} from '../src/scheduler.js';

/** In-memory lock port shared by several schedulers (stands in for one database). */
class MemoryLocks implements LockProvider {
  held = new Set<string>();
  acquired = 0;
  async tryAcquire(name: string) {
    if (this.held.has(name)) return null;
    this.held.add(name);
    this.acquired++;
    return { release: async () => void this.held.delete(name) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, timeoutMs = 5_000) => {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
};

const live: Scheduler[] = [];
const make = (
  runners: RunnerSpec[],
  locks: LockProvider = new MemoryLocks(),
  signal = new AbortController().signal,
) => {
  const s = new Scheduler({
    runners,
    locks,
    signal,
    minIntervalMs: 10,
    initialDelayMaxMs: 5,
    drainTimeoutMs: 2_000,
  });
  live.push(s);
  return s;
};
afterEach(async () => {
  while (live.length) await live.pop()!.stop();
});

describe('T-057 worker scheduler: bounded intervals with jitter', () => {
  it('keeps every jittered delay inside interval*(1±jitter)', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const d = jitteredDelay(10_000, 0.2, r);
      expect(d).toBeGreaterThanOrEqual(8_000);
      expect(d).toBeLessThanOrEqual(12_000);
    }
    expect(jitteredDelay(10_000, 0, 0.9)).toBe(10_000);
  });

  it('refuses unbounded or invalid intervals, jitter and runner names', () => {
    const ok: RunnerSpec = { name: 'test.ok', intervalMs: 1_000, run: async () => {} };
    expect(() => make([{ ...ok, intervalMs: 0 }])).toThrow(/interval/i);
    expect(() => make([{ ...ok, intervalMs: 25 * 3_600_000 }])).toThrow(/interval/i);
    expect(() => make([{ ...ok, jitter: 0.9 }])).toThrow(/jitter/i);
    expect(() => make([{ ...ok, name: 'Bad Name!' }])).toThrow(/name/i);
    expect(() => make([ok, ok])).toThrow(/duplicate/i);
    expect(() => jitteredDelay(1_000, 0.2, 1)).toThrow();
  });
});

describe('T-057 worker scheduler: every runner is scheduled', () => {
  it('start() ticks each registered runner repeatedly on its own interval', async () => {
    const counts: Record<string, number> = { 'test.a': 0, 'test.b': 0, 'test.c': 0 };
    const runners = Object.keys(counts).map((name): RunnerSpec => ({
      name,
      intervalMs: 20,
      run: async () => void counts[name]!++,
    }));
    const s = make(runners);
    s.start();
    await until(() => Object.values(counts).every((n) => n >= 3));
    const status = s.status();
    expect(status.map((r) => r.name).sort()).toEqual(Object.keys(counts).sort());
    for (const r of status) {
      expect(r.lastOutcome).toBe('OK');
      expect(r.ticks).toBeGreaterThanOrEqual(3);
      expect(r.lastSuccessAt).not.toBeNull();
    }
  });
});

describe('T-057 worker scheduler: per-runner locking', () => {
  it('two schedulers sharing one lock port never run the same runner concurrently', async () => {
    const locks = new MemoryLocks();
    let running = 0;
    let maxRunning = 0;
    let executions = 0;
    const spec = (): RunnerSpec => ({
      name: 'test.exclusive',
      intervalMs: 1_000,
      run: async () => {
        running++;
        executions++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(50);
        running--;
      },
    });
    const a = make([spec()], locks);
    const b = make([spec()], locks);
    const outcomes = await Promise.all([a.tick('test.exclusive'), b.tick('test.exclusive')]);
    expect(outcomes.sort()).toEqual(['OK', 'SKIPPED_LOCKED']);
    expect(executions).toBe(1);
    expect(maxRunning).toBe(1);
    expect(locks.held.size).toBe(0);
    // Once released, the other replica can take the next tick.
    expect(await b.tick('test.exclusive')).toBe('OK');
    expect(executions).toBe(2);
  });

  it('a runner still running in this process is not started again (SKIPPED_BUSY)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = make([{ name: 'test.slow', intervalMs: 1_000, run: () => gate }]);
    const first = s.tick('test.slow');
    await sleep(5);
    expect(await s.tick('test.slow')).toBe('SKIPPED_BUSY');
    release();
    expect(await first).toBe('OK');
  });
});

describe('T-057 worker scheduler: failure isolation', () => {
  it('a runner that always throws does not stop the others or crash the process', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      let healthy = 0;
      const s = make([
        {
          name: 'test.broken',
          intervalMs: 15,
          run: async () => {
            throw new Error('dependency down');
          },
        },
        { name: 'test.healthy', intervalMs: 15, run: async () => void healthy++ },
      ]);
      s.start();
      await until(() => healthy >= 5);
      const broken = s.status().find((r) => r.name === 'test.broken')!;
      expect(broken.lastOutcome).toBe('FAILED');
      expect(broken.consecutiveFailures).toBeGreaterThanOrEqual(2);
      expect(s.status().find((r) => r.name === 'test.healthy')!.consecutiveFailures).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a lock provider failure is a FAILED tick of that runner only', async () => {
    const locks: LockProvider = {
      tryAcquire: async (name) => {
        if (name === 'test.lockfail') throw new Error('connection refused');
        return { release: async () => {} };
      },
    };
    const s = make(
      [
        { name: 'test.lockfail', intervalMs: 1_000, run: async () => {} },
        { name: 'test.fine', intervalMs: 1_000, run: async () => {} },
      ],
      locks,
    );
    expect(await s.tick('test.lockfail')).toBe('FAILED');
    expect(await s.tick('test.fine')).toBe('OK');
  });

  it('a tick exceeding its timeout is aborted and recorded TIMED_OUT, and its lock is released afterwards', async () => {
    const locks = new MemoryLocks();
    let sawAbort = false;
    const s = make(
      [
        {
          name: 'test.hang',
          intervalMs: 1_000,
          timeoutMs: 100,
          run: (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => {
                sawAbort = true;
                resolve();
              });
            }),
        },
      ],
      locks,
    );
    expect(await s.tick('test.hang')).toBe('TIMED_OUT');
    expect(sawAbort).toBe(true);
    expect(locks.held.size).toBe(0);
  });
});

describe('T-057 worker scheduler: graceful shutdown', () => {
  it('stop() lets the in-flight tick finish, releases its lock and starts nothing new', async () => {
    const locks = new MemoryLocks();
    let finished = false;
    let starts = 0;
    let aborted = false;
    const s = make(
      [
        {
          name: 'test.drain',
          intervalMs: 10,
          run: async (signal) => {
            starts++;
            await sleep(100);
            aborted = signal.aborted;
            finished = true;
          },
        },
      ],
      locks,
    );
    s.start();
    await until(() => starts === 1);
    const r = await s.stop();
    expect(r.drained).toBe(true);
    expect(finished).toBe(true);
    // The in-flight run observed the shutdown request through its signal.
    expect(aborted).toBe(true);
    expect(locks.held.size).toBe(0);
    await sleep(60);
    expect(starts).toBe(1);
    expect(await s.tick('test.drain')).toBe<TickOutcome>('SKIPPED_STOPPING');
  });

  it('aborting the root signal shuts the scheduler down', async () => {
    const root = new AbortController();
    let n = 0;
    const s = make([{ name: 'test.root', intervalMs: 10, run: async () => void n++ }], new MemoryLocks(), root.signal);
    s.start();
    await until(() => n >= 2);
    root.abort();
    await s.stopped;
    const after = n;
    await sleep(60);
    expect(n).toBe(after);
  });

  it('stop() reports drained=false when an in-flight tick outlives the drain timeout', async () => {
    const s = new Scheduler({
      runners: [{ name: 'test.stuck', intervalMs: 1_000, run: () => new Promise(() => {}) }],
      locks: new MemoryLocks(),
      signal: new AbortController().signal,
      minIntervalMs: 10,
      drainTimeoutMs: 50,
    });
    void s.tick('test.stuck');
    await sleep(5);
    expect((await s.stop()).drained).toBe(false);
  });
});

describe('T-057 worker scheduler: metrics', () => {
  it('records ticks, outcomes and durations with closed runner/outcome labels only', async () => {
    const registry = new MetricsRegistry();
    const metrics = workerMetrics(registry, ['test.m1', 'test.m2']);
    const s = new Scheduler({
      runners: [
        { name: 'test.m1', intervalMs: 1_000, run: async () => ({ work: 3 }) },
        {
          name: 'test.m2',
          intervalMs: 1_000,
          run: async () => {
            throw new Error('x');
          },
        },
      ],
      locks: new MemoryLocks(),
      signal: new AbortController().signal,
      metrics,
    });
    live.push(s);
    await s.tick('test.m1');
    await s.tick('test.m2');
    expect(registry.value('ub_worker_runner_ticks_total', { runner: 'test.m1', outcome: 'OK' })).toBe(1);
    expect(registry.value('ub_worker_runner_ticks_total', { runner: 'test.m2', outcome: 'FAILED' })).toBe(1);
    expect(registry.value('ub_worker_runner_work_items_total', { runner: 'test.m1' })).toBe(3);
    const text = registry.exposition();
    expect(text).toContain('ub_worker_runner_duration_seconds');
    expect(text).not.toMatch(/tenant|incident/);
    // A runner name outside the declared set can never become a label value.
    expect(() => workerMetrics(new MetricsRegistry(), ['Not A Name'])).toThrow();
  });
});
