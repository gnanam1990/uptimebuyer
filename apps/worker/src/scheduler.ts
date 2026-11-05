// Worker scheduler (M14; T-057, NFR-08, NFR-09). Each runner ticks on its own bounded interval with jitter. Before any
// work, a tick takes the runner's lock through the lock port (a PostgreSQL session advisory lock in production), so two
// worker replicas never run the same runner at the same time; a replica that loses the race records SKIPPED_LOCKED.
// The runner lock is taken first and without waiting (try-lock), outside every lock of the global order (ADR 0006), so
// it can never take part in a deadlock. A failing, slow or hanging runner affects only its own ticks: errors are
// caught and counted, a tick past its timeout has its signal aborted, and a runner already running in this process is
// not started again. Shutdown is bound to the root AbortSignal: no new tick starts, in-flight ticks see their signal
// aborted and are awaited up to a drain bound, and their locks are released before the scheduler reports stopped.
import { randomInt } from 'node:crypto';
import type { MetricsRegistry, StructuredLogger } from '@uptimebuyer/observability';
import type pg from 'pg';

export type TickOutcome = 'OK' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_LOCKED' | 'SKIPPED_BUSY' | 'SKIPPED_STOPPING';
export const TICK_OUTCOMES: readonly TickOutcome[] = Object.freeze([
  'OK',
  'FAILED',
  'TIMED_OUT',
  'SKIPPED_LOCKED',
  'SKIPPED_BUSY',
  'SKIPPED_STOPPING',
]);

export interface RunnerSpec {
  /** Closed, metric-safe name, e.g. `outbox.publish`. */
  readonly name: string;
  readonly intervalMs: number;
  /** Fraction of the interval used as symmetric jitter (0 to 0.5; default 0.2). */
  readonly jitter?: number;
  /** Per-tick bound; the tick's signal is aborted when it elapses (default min(4 x interval, 10 min)). */
  readonly timeoutMs?: number;
  run(signal: AbortSignal): Promise<{ work?: number } | void>;
}

export interface HeldLock {
  release(): Promise<void>;
  /** Aborted when exclusivity is lost while held (for example the lock's database session died). */
  readonly lost?: AbortSignal;
}
/** Exclusive, non-blocking lock per runner name shared by every replica. */
export interface LockProvider {
  tryAcquire(name: string): Promise<HeldLock | null>;
  /** Called once by Scheduler.stop() after draining (only when every in-flight tick finished). */
  close?(): Promise<void>;
}

/**
 * PostgreSQL session advisory locks keyed `worker-runner:<name>` (the `pg_try_advisory_lock(hashtextextended(...))`
 * pattern of the M07 broker hand-off), all held on ONE dedicated session per replica. Runner work never waits for a
 * lock connection, so a replica can never exhaust its pool with lock holders while their runners wait for
 * connections. A session that dies drops every lock with it: each holder is told exclusivity is lost (its tick is
 * aborted), so a crashed replica never blocks the others and a surviving replica never keeps working without its lock.
 */
export class PgAdvisoryLocks implements LockProvider {
  private client: pg.PoolClient | null = null;
  private connecting: Promise<pg.PoolClient> | null = null;
  private readonly held = new Map<string, AbortController>();
  /** Queries on the shared session run one at a time (pg deprecates overlapping queries on one client). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pool: pg.Pool,
    private readonly namespace = 'worker-runner',
  ) {}

  private session(): Promise<pg.PoolClient> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.pool.connect().then(
      (client) => {
        // A checked-out client reports a dead session on itself, not on the pool: without this listener the error
        // would crash the process.
        client.on('error', (e: Error) => this.lose(client, e));
        this.client = client;
        this.connecting = null;
        return client;
      },
      (e: unknown) => {
        this.connecting = null;
        throw e;
      },
    );
    return this.connecting;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private lose(client: pg.PoolClient, e: Error): void {
    if (this.client !== client) return;
    this.client = null;
    for (const c of this.held.values()) c.abort();
    this.held.clear();
    client.release(e);
  }

  async tryAcquire(name: string): Promise<HeldLock | null> {
    const key = `${this.namespace}:${name}`;
    const client = await this.session();
    let ok: boolean;
    try {
      const { rows } = await this.serial(() =>
        client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]),
      );
      ok = rows[0]?.ok === true;
    } catch (e) {
      this.lose(client, e as Error);
      throw e;
    }
    if (!ok) return null;
    const lost = new AbortController();
    this.held.set(name, lost);
    let released = false;
    return {
      lost: lost.signal,
      release: async () => {
        if (released) return;
        released = true;
        if (this.held.get(name) !== lost || this.client !== client) return; // session already gone with the lock
        this.held.delete(name);
        await this.serial(() => client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])).catch(
          (e: Error) => {
            this.lose(client, e);
          },
        );
      },
    };
  }

  /** Release the dedicated session (and with it every lock). */
  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    for (const l of this.held.values()) l.abort();
    this.held.clear();
    c?.release();
  }
}

/** Interval with symmetric jitter: interval x (1 + jitter x (2r - 1)), r in [0, 1). */
export function jitteredDelay(intervalMs: number, jitter: number, r: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('interval must be positive');
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 0.5) throw new RangeError('jitter must be within [0, 0.5]');
  if (!Number.isFinite(r) || r < 0 || r >= 1) throw new RangeError('r must be within [0, 1)');
  return Math.round(intervalMs * (1 + jitter * (2 * r - 1)));
}

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_INTERVAL_MS = 24 * 3_600_000;
const DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 15, 60, 300, 600];

export interface WorkerMetrics {
  tick(runner: string, outcome: TickOutcome, seconds: number | null, work: number): void;
  running(runner: string, n: number): void;
}

/** Closed-label worker metrics: the runner label is limited to the declared runner names. */
export function workerMetrics(registry: MetricsRegistry, runnerNames: readonly string[]): WorkerMetrics {
  for (const n of runnerNames) if (!NAME.test(n) || n.length > 64) throw new RangeError(`invalid runner name ${n}`);
  const runner = [...runnerNames];
  const ticks = registry.counter('ub_worker_runner_ticks_total', 'Worker runner ticks by outcome.', {
    runner,
    outcome: [...TICK_OUTCOMES],
  });
  const duration = registry.histogram(
    'ub_worker_runner_duration_seconds',
    'Worker runner tick duration.',
    DURATION_BUCKETS,
    { runner },
  );
  const work = registry.counter('ub_worker_runner_work_items_total', 'Items processed by worker runners.', { runner });
  const last = registry.gauge(
    'ub_worker_runner_last_success_timestamp_seconds',
    'Unix time of the last successful tick.',
    { runner },
  );
  const active = registry.gauge('ub_worker_runner_running', 'Worker runner ticks in progress.', { runner });
  return {
    tick(name, outcome, seconds, items) {
      ticks.inc({ runner: name, outcome });
      if (seconds !== null) duration.observe({ runner: name }, seconds);
      if (items > 0) work.inc({ runner: name }, items);
      if (outcome === 'OK') last.set({ runner: name }, Math.floor(Date.now() / 1000));
    },
    running(name, n) {
      active.set({ runner: name }, n);
    },
  };
}

export interface RunnerStatus {
  name: string;
  intervalMs: number;
  ticks: number;
  running: boolean;
  lastOutcome: TickOutcome | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

export interface SchedulerOptions {
  runners: readonly RunnerSpec[];
  locks: LockProvider;
  /** Root shutdown signal: aborting it stops the scheduler. */
  signal: AbortSignal;
  random?: () => number;
  metrics?: WorkerMetrics;
  logger?: StructuredLogger;
  drainTimeoutMs?: number;
  minIntervalMs?: number;
  initialDelayMaxMs?: number;
}

interface Slot {
  spec: RunnerSpec;
  jitter: number;
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  inflight: Promise<TickOutcome> | null;
  status: RunnerStatus;
}

const cryptoRandom = () => randomInt(0, 1_000_000) / 1_000_000;

export class Scheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly random: () => number;
  private readonly drainTimeoutMs: number;
  private readonly initialDelayMaxMs: number;
  private readonly shutdown = new AbortController();
  private stopping = false;
  private started = false;
  private resolveStopped!: () => void;
  /** Resolves once the scheduler has stopped and drained (or given up draining). */
  readonly stopped: Promise<void> = new Promise((r) => (this.resolveStopped = r));
  private stopResult: Promise<{ drained: boolean }> | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    const min = opts.minIntervalMs ?? 1_000;
    for (const spec of opts.runners) {
      if (typeof spec.name !== 'string' || !NAME.test(spec.name) || spec.name.length > 64)
        throw new RangeError(`invalid runner name: ${String(spec.name)}`);
      if (this.slots.has(spec.name)) throw new RangeError(`duplicate runner name: ${spec.name}`);
      if (!Number.isInteger(spec.intervalMs) || spec.intervalMs < min || spec.intervalMs > MAX_INTERVAL_MS)
        throw new RangeError(`runner ${spec.name}: interval must be within [${min}, ${MAX_INTERVAL_MS}] ms`);
      const jitter = spec.jitter ?? 0.2;
      if (!Number.isFinite(jitter) || jitter < 0 || jitter > 0.5)
        throw new RangeError(`runner ${spec.name}: jitter must be within [0, 0.5]`);
      const timeoutMs = spec.timeoutMs ?? Math.min(spec.intervalMs * 4, 600_000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 3_600_000)
        throw new RangeError(`runner ${spec.name}: timeout out of bounds`);
      this.slots.set(spec.name, {
        spec,
        jitter,
        timeoutMs,
        timer: null,
        inflight: null,
        status: {
          name: spec.name,
          intervalMs: spec.intervalMs,
          ticks: 0,
          running: false,
          lastOutcome: null,
          lastStartedAt: null,
          lastSuccessAt: null,
          consecutiveFailures: 0,
        },
      });
    }
    this.random = opts.random ?? cryptoRandom;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
    this.initialDelayMaxMs = opts.initialDelayMaxMs ?? 5_000;
    if (opts.signal.aborted) void this.stop();
    else opts.signal.addEventListener('abort', () => void this.stop(), { once: true });
  }

  /** Schedule every runner: a small random initial delay, then its jittered interval after each tick. */
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const slot of this.slots.values()) {
      const first = Math.floor(this.random() * Math.min(this.initialDelayMaxMs, slot.spec.intervalMs));
      this.arm(slot, first);
    }
  }

  private arm(slot: Slot, delay: number): void {
    if (this.stopping) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.tick(slot.spec.name).finally(() => {
        if (!this.stopping) this.arm(slot, jitteredDelay(slot.spec.intervalMs, slot.jitter, this.random()));
      });
    }, delay);
    slot.timer.unref?.();
  }

  /** Run one tick of a runner now (also used by tests and operators). Never throws. */
  async tick(name: string): Promise<TickOutcome> {
    const slot = this.slots.get(name);
    if (!slot) throw new RangeError(`unknown runner: ${name}`);
    if (this.stopping) return this.record(slot, 'SKIPPED_STOPPING', null, 0);
    if (slot.inflight) return this.record(slot, 'SKIPPED_BUSY', null, 0);
    const p = this.execute(slot);
    slot.inflight = p;
    try {
      return await p;
    } finally {
      slot.inflight = null;
    }
  }

  private async execute(slot: Slot): Promise<TickOutcome> {
    let lock: HeldLock | null;
    try {
      lock = await this.opts.locks.tryAcquire(slot.spec.name);
    } catch {
      this.opts.logger?.warn('worker.lock_failed', { runner: slot.spec.name });
      return this.record(slot, 'FAILED', null, 0);
    }
    if (!lock) return this.record(slot, 'SKIPPED_LOCKED', null, 0);
    const tickAbort = new AbortController();
    const onShutdown = () => tickAbort.abort();
    this.shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    let lockLost = false;
    const onLost = () => {
      lockLost = true;
      this.opts.logger?.warn('worker.lock_lost', { runner: slot.spec.name });
      tickAbort.abort();
    };
    if (lock.lost?.aborted) onLost();
    else lock.lost?.addEventListener('abort', onLost, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      tickAbort.abort();
    }, slot.timeoutMs);
    timer.unref?.();
    const started = performance.now();
    slot.status.running = true;
    slot.status.lastStartedAt = new Date().toISOString();
    this.opts.metrics?.running(slot.spec.name, 1);
    let outcome: TickOutcome;
    let work = 0;
    try {
      const r = await slot.spec.run(tickAbort.signal);
      work = r && typeof r.work === 'number' && Number.isFinite(r.work) && r.work > 0 ? r.work : 0;
      outcome = lockLost ? 'FAILED' : timedOut ? 'TIMED_OUT' : 'OK';
    } catch (e) {
      outcome = timedOut ? 'TIMED_OUT' : 'FAILED';
      this.opts.logger?.warn('worker.runner_failed', {
        runner: slot.spec.name,
        reasonCode: (e as { code?: unknown })?.code === undefined ? 'ERROR' : String((e as { code: unknown }).code),
      });
    } finally {
      clearTimeout(timer);
      this.shutdown.signal.removeEventListener('abort', onShutdown);
      lock.lost?.removeEventListener('abort', onLost);
      slot.status.running = false;
      this.opts.metrics?.running(slot.spec.name, 0);
      await lock.release().catch(() => {
        this.opts.logger?.warn('worker.unlock_failed', { runner: slot.spec.name });
      });
    }
    return this.record(slot, outcome, (performance.now() - started) / 1000, work);
  }

  private record(slot: Slot, outcome: TickOutcome, seconds: number | null, work: number): TickOutcome {
    const s = slot.status;
    if (outcome === 'OK' || outcome === 'FAILED' || outcome === 'TIMED_OUT') {
      s.ticks++;
      s.lastOutcome = outcome;
      if (outcome === 'OK') {
        s.consecutiveFailures = 0;
        s.lastSuccessAt = new Date().toISOString();
      } else s.consecutiveFailures++;
    }
    try {
      this.opts.metrics?.tick(slot.spec.name, outcome, seconds, work);
    } catch {
      // A metrics failure never changes the outcome of a tick.
    }
    return outcome;
  }

  status(): RunnerStatus[] {
    return [...this.slots.values()].map((s) => ({ ...s.status }));
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Stop scheduling, signal in-flight ticks, and await them up to the drain bound. Idempotent. */
  stop(): Promise<{ drained: boolean }> {
    if (this.stopResult) return this.stopResult;
    this.stopping = true;
    for (const slot of this.slots.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
    }
    this.shutdown.abort();
    const inflight = [...this.slots.values()].map((s) => s.inflight).filter((p): p is Promise<TickOutcome> => !!p);
    this.stopResult = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        Promise.allSettled(inflight).then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), this.drainTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (drained) await this.opts.locks.close?.().catch(() => {});
      this.opts.logger?.info('worker.scheduler_stopped', { drained });
      this.resolveStopped();
      return { drained };
    })();
    return this.stopResult;
  }
}
