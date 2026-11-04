// Bounded ingestion scheduling and per-device rate buckets (NFR-04). Live work always runs before queued backfill;
// both queues are bounded and refuse new work with RATE_LIMITED (backpressure) rather than buffering without
// bound. Rate buckets are token buckets in messages, refilled from the injected clock; the number of tracked
// devices is bounded (least recently used buckets are dropped first).
import { DomainError } from '@uptimebuyer/contracts';
import type { Clock } from '@uptimebuyer/telemetry';

export type Priority = 'LIVE' | 'BACKFILL';

interface Task {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class IngestScheduler {
  private readonly live: Task[] = [];
  private readonly backfill: Task[] = [];
  private running = 0;

  constructor(private readonly opts: { maxConcurrent: number; maxQueuedLive: number; maxQueuedBackfill: number }) {
    for (const [k, v] of Object.entries(opts))
      if (!Number.isSafeInteger(v) || v < 1) throw new Error(`IngestScheduler ${k} must be a positive integer.`);
  }

  depth(): { running: number; live: number; backfill: number } {
    return { running: this.running, live: this.live.length, backfill: this.backfill.length };
  }

  schedule<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    const queue = priority === 'LIVE' ? this.live : this.backfill;
    const max = priority === 'LIVE' ? this.opts.maxQueuedLive : this.opts.maxQueuedBackfill;
    if (this.running >= this.opts.maxConcurrent && queue.length >= max)
      return Promise.reject(
        new DomainError('RATE_LIMITED', 'Ingestion is saturated; retry later.', {
          reasonCode: 'INGEST_QUEUE_FULL',
          retryAfterMs: 1_000,
        }),
      );
    return new Promise<T>((resolve, reject) => {
      queue.push({ run, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.opts.maxConcurrent) {
      const task = this.live.shift() ?? this.backfill.shift();
      if (!task) return;
      this.running++;
      void Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

export interface RateBucketConfig {
  capacityMessages: number;
  refillMessagesPerSecond: number;
  maxTrackedKeys?: number;
}

export class RateBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxKeys: number;

  constructor(
    private readonly cfg: RateBucketConfig,
    private readonly clock: Clock,
  ) {
    if (!(cfg.capacityMessages >= 1) || !(cfg.refillMessagesPerSecond > 0))
      throw new Error('Rate bucket capacity and refill must be positive.');
    this.maxKeys = cfg.maxTrackedKeys ?? 100_000;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Whether `n` tokens are available for `key` now (does not consume, does not create a bucket). */
  has(key: string, n: number): boolean {
    const b = this.buckets.get(key);
    if (!b) return n <= this.cfg.capacityMessages;
    return this.refilled(b, this.clock.now()) >= n;
  }

  private refilled(b: { tokens: number; at: number }, now: number): number {
    const elapsed = Math.max(0, now - b.at);
    return Math.min(this.cfg.capacityMessages, b.tokens + (elapsed * this.cfg.refillMessagesPerSecond) / 1000);
  }

  /** Return `n` previously taken tokens (a reservation that turned out not to be a failure). */
  refund(key: string, n: number): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.cfg.capacityMessages, b.tokens + n);
  }

  /** Take `n` tokens for `key`; on refusal, `retryAfterMs` is when enough tokens will exist (∞ if never). */
  take(key: string, n: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.clock.now();
    let b = this.buckets.get(key);
    if (b) this.buckets.delete(key);
    else {
      b = { tokens: this.cfg.capacityMessages, at: now };
      while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    }
    b.tokens = this.refilled(b, now);
    b.at = now;
    this.buckets.set(key, b); // most recently used last
    if (n > this.cfg.capacityMessages) return { ok: false, retryAfterMs: Number.POSITIVE_INFINITY };
    if (b.tokens >= n) {
      b.tokens -= n;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil(((n - b.tokens) * 1000) / this.cfg.refillMessagesPerSecond) };
  }
}

/**
 * Bounded TTL cache of device credential keys learned from successful authentications, plus a bounded memory of
 * token ids already presented. It lets the gateway recognise a valid, unreplayed credential without spending any
 * failure budget; it is never a substitute for authentication (revocation and single-use jti stay in the database).
 */
export class KnownCredentials {
  private readonly keys = new Map<string, { key: Uint8Array; expiresAt: number }>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly opts: { ttlMs: number; maxKeys: number; maxSeenTokens: number },
  ) {}

  get(kid: string): Uint8Array | null {
    const e = this.keys.get(kid);
    if (!e) return null;
    if (e.expiresAt <= this.clock.now()) {
      this.keys.delete(kid);
      return null;
    }
    return e.key;
  }

  remember(kid: string, key: Uint8Array): void {
    this.keys.delete(kid);
    while (this.keys.size >= this.opts.maxKeys) this.keys.delete(this.keys.keys().next().value!);
    this.keys.set(kid, { key, expiresAt: this.clock.now() + this.opts.ttlMs });
  }

  forget(kid: string): void {
    this.keys.delete(kid);
  }

  /** Record a token id; returns false when it was already presented (a replay). */
  firstUse(jti: string): boolean {
    if (this.seen.has(jti)) return false;
    while (this.seen.size >= this.opts.maxSeenTokens) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(jti, this.clock.now());
    return true;
  }
}
