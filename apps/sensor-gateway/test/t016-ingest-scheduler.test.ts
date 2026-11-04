// T-016 — Edge reconnect and bounded backfill (gateway unit layer): queued live ingestion always runs before queued
// backfill, both queues are bounded (backpressure, never unbounded memory), and per-device rate buckets refill
// deterministically from the injected clock and report a retry hint.
import { ManualClock } from '@uptimebuyer/telemetry';
import { describe, expect, it } from 'vitest';
import { IngestScheduler, RateBuckets } from '../src/index.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('T-016 gateway ingest scheduling', () => {
  it('runs queued live work before queued backfill work, whatever the arrival order', async () => {
    const s = new IngestScheduler({ maxConcurrent: 1, maxQueuedLive: 10, maxQueuedBackfill: 10 });
    const gate = deferred();
    const order: string[] = [];
    const blocker = s.schedule('BACKFILL', async () => {
      await gate.promise;
      order.push('blocker');
    });
    const work = [
      s.schedule('BACKFILL', async () => void order.push('b1')),
      s.schedule('BACKFILL', async () => void order.push('b2')),
      s.schedule('LIVE', async () => void order.push('l1')),
      s.schedule('BACKFILL', async () => void order.push('b3')),
      s.schedule('LIVE', async () => void order.push('l2')),
    ];
    expect(s.depth()).toEqual({ running: 1, live: 2, backfill: 3 });
    gate.resolve();
    await Promise.all([blocker, ...work]);
    expect(order).toEqual(['blocker', 'l1', 'l2', 'b1', 'b2', 'b3']);
    expect(s.depth()).toEqual({ running: 0, live: 0, backfill: 0 });
  });

  it('applies backpressure when a queue is full instead of buffering without bound', async () => {
    const s = new IngestScheduler({ maxConcurrent: 1, maxQueuedLive: 1, maxQueuedBackfill: 1 });
    const gate = deferred();
    const running = s.schedule('LIVE', () => gate.promise);
    const q1 = s.schedule('BACKFILL', async () => 1);
    await expect(s.schedule('BACKFILL', async () => 2)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { reasonCode: 'INGEST_QUEUE_FULL' },
    });
    const q2 = s.schedule('LIVE', async () => 3);
    await expect(s.schedule('LIVE', async () => 4)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    gate.resolve();
    await expect(Promise.all([running, q1, q2])).resolves.toEqual([undefined, 1, 3]);
  });

  it('a failing task does not wedge the queue', async () => {
    const s = new IngestScheduler({ maxConcurrent: 1, maxQueuedLive: 5, maxQueuedBackfill: 5 });
    const bad = s.schedule('LIVE', async () => {
      throw new Error('boom');
    });
    const good = s.schedule('LIVE', async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });

  it('per-device rate buckets refill from the injected clock and give a retry hint', () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 4));
    const b = new RateBuckets({ capacityMessages: 4, refillMessagesPerSecond: 2 }, clock);
    expect(b.take('dev_a', 3)).toEqual({ ok: true });
    expect(b.take('dev_a', 3)).toEqual({ ok: false, retryAfterMs: 1_000 });
    expect(b.take('dev_b', 4)).toEqual({ ok: true });
    clock.advance(1_000);
    expect(b.take('dev_a', 3)).toEqual({ ok: true });
    expect(b.take('dev_a', 5)).toEqual({ ok: false, retryAfterMs: Number.POSITIVE_INFINITY });
    clock.advance(60_000);
    expect(b.take('dev_a', 4)).toEqual({ ok: true });
  });

  it('bounds the number of tracked devices', () => {
    const clock = new ManualClock(0);
    const b = new RateBuckets({ capacityMessages: 1, refillMessagesPerSecond: 1, maxTrackedKeys: 3 }, clock);
    for (const k of ['a', 'b', 'c', 'd', 'e']) b.take(k, 1);
    expect(b.size).toBeLessThanOrEqual(3);
  });
});
