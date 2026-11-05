// T-054 (NFR-04, INV-08) — every bound accepts exactly at its limit and rejects explicitly one step beyond it:
// token-bucket rate, concurrency bulkhead with a bounded queue (load shedding is a typed RATE_LIMITED/LOAD_SHED with
// a retry hint, never silent queuing), deadlines, retry decisions (an external effect is never retried autonomously
// without a reconciliation key), body size and model token/cost budgets.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@uptimebuyer/contracts';
import { Bulkhead, ModelBudget, RetryPolicy, TokenBucket, assertWithinBytes, withDeadline } from '../src/index.js';

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ACCEPTED';
  } catch (e) {
    return e instanceof DomainError ? `${e.code}:${String(e.details.reasonCode)}` : `ERR:${(e as Error).message}`;
  }
};

describe('T-054 token bucket rate bound', () => {
  it('admits exactly `capacity` in a burst, refuses the next with a retry hint, and refills at the declared rate', () => {
    let now = 1_000_000;
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 2 }, () => now);
    for (let i = 0; i < 5; i++) expect(b.tryTake()).toEqual({ ok: true });
    const r = b.tryTake();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.retryAfterMs).toBe(500);
    now += 499;
    expect(b.tryTake().ok).toBe(false);
    now += 1;
    expect(b.tryTake()).toEqual({ ok: true });
    now += 60_000;
    for (let i = 0; i < 5; i++) expect(b.tryTake().ok).toBe(true);
    expect(b.tryTake().ok).toBe(false);
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
  });
});

describe('T-054 concurrency bulkhead and load shedding', () => {
  it('runs maxConcurrent, queues maxQueued, sheds the next explicitly, and drains in order', async () => {
    const shed: string[] = [];
    const bh = new Bulkhead({ name: 'api_requests', maxConcurrent: 2, maxQueued: 1, queueTimeoutMs: 5_000 }, (b) =>
      shed.push(b),
    );
    const gates: (() => void)[] = [];
    const work = () =>
      bh.run(
        () =>
          new Promise<string>((resolve) => {
            gates.push(() => resolve('done'));
          }),
      );
    const a = work();
    const b = work();
    const c = work();
    await new Promise((r) => setTimeout(r, 5));
    expect(bh.stats()).toEqual({ active: 2, queued: 1 });
    const d = await reasonOf(work());
    expect(d).toBe('RATE_LIMITED:LOAD_SHED');
    expect(shed).toEqual(['api_requests']);
    gates.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 5));
    expect(bh.stats()).toEqual({ active: 2, queued: 0 });
    gates.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 5));
    gates.splice(0).forEach((g) => g());
    expect(await Promise.all([b, c])).toEqual(['done', 'done']);
    expect(bh.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('sheds a queued request that waits past the queue timeout and releases a slot when work throws', async () => {
    const bh = new Bulkhead({ name: 'provider_calls', maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 20 });
    let release!: () => void;
    const first = bh.run(() => new Promise<void>((r) => (release = r)));
    expect(await reasonOf(bh.run(async () => 'late'))).toBe('RATE_LIMITED:QUEUE_TIMEOUT');
    release();
    await first;
    expect(await reasonOf(bh.run(async () => Promise.reject(new Error('boom'))))).toBe('ERR:boom');
    expect(bh.stats()).toEqual({ active: 0, queued: 0 });
  });
});

describe('T-054 deadline bound', () => {
  it('completes inside the deadline and aborts beyond it with a typed outcome', async () => {
    expect(await withDeadline(50, async () => 'ok', { effect: 'NONE' })).toBe('ok');
    let aborted = false;
    const slow = withDeadline(
      20,
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve('late'), 200);
        }),
      { effect: 'NONE' },
    );
    expect(await reasonOf(slow)).toBe('DEPENDENCY_FAILED:DEADLINE_EXCEEDED');
    expect(aborted).toBe(true);
    // An operation that may have had an external effect becomes UNKNOWN, never a definite failure (INV-08).
    expect(await reasonOf(withDeadline(10, () => new Promise(() => {}), { effect: 'EXTERNAL_EFFECT' }))).toBe(
      'DEPENDENCY_OUTCOME_UNKNOWN:DEADLINE_EXCEEDED',
    );
  });
});

describe('T-054 retry bound (INV-08)', () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000 });

  it('backs off exponentially up to the cap and stops at maxAttempts', () => {
    expect(policy.decide({ attempt: 1, effect: 'IDEMPOTENT' })).toEqual({ retry: true, delayMs: 1_000 });
    expect(policy.decide({ attempt: 2, effect: 'IDEMPOTENT' })).toEqual({ retry: true, delayMs: 2_000 });
    expect(policy.decide({ attempt: 3, effect: 'IDEMPOTENT' })).toEqual({ retry: false, reason: 'MAX_ATTEMPTS' });
    const wide = new RetryPolicy({ maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 4_000 });
    expect(wide.decide({ attempt: 5, effect: 'NONE' })).toEqual({ retry: true, delayMs: 4_000 });
  });

  it('never retries an external effect autonomously without a pre-existing reconciliation key', () => {
    expect(policy.decide({ attempt: 1, effect: 'EXTERNAL_EFFECT' })).toEqual({
      retry: false,
      reason: 'NO_RECONCILIATION_KEY',
    });
    expect(policy.decide({ attempt: 1, effect: 'EXTERNAL_EFFECT', reconciliationKey: '' })).toEqual({
      retry: false,
      reason: 'NO_RECONCILIATION_KEY',
    });
    expect(policy.decide({ attempt: 1, effect: 'EXTERNAL_EFFECT', reconciliationKey: 'cop_0001-abcd' })).toEqual({
      retry: true,
      delayMs: 1_000,
    });
    expect(policy.decide({ attempt: 1, effect: 'IDEMPOTENT', terminal: true })).toEqual({
      retry: false,
      reason: 'TERMINAL',
    });
  });
});

describe('T-054 size bound', () => {
  it('accepts exactly the limit and rejects one byte more', () => {
    expect(() => assertWithinBytes(new Uint8Array(1024), 1024)).not.toThrow();
    expect(() => assertWithinBytes(new Uint8Array(1025), 1024)).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reasonCode: 'BODY_TOO_LARGE' }) }),
    );
    expect(() => assertWithinBytes('é'.repeat(513), 1024)).toThrow();
  });
});

describe('T-054 model token and cost budget', () => {
  const limits = {
    maxPromptTokens: 1_000,
    maxCompletionTokens: 500,
    maxTotalTokens: 1_200,
    maxCostMicros: 10_000n,
    pricePerMillionPromptMicros: 5_000_000n,
    pricePerMillionCompletionMicros: 10_000_000n,
  };

  it('admits usage exactly at each limit and rejects one token beyond', () => {
    const b = new ModelBudget({ ...limits, maxCostMicros: null });
    expect(b.charge({ promptTokens: 700, completionTokens: 500 })).toMatchObject({ ok: true, totalTokens: 1_200 });
    expect(b.charge({ promptTokens: 0, completionTokens: 0 }).ok).toBe(true);
    expect(b.charge({ promptTokens: 1, completionTokens: 0 })).toEqual({ ok: false, reason: 'TOKEN_BUDGET_EXCEEDED' });
    const p = new ModelBudget({ ...limits, maxCostMicros: null });
    expect(p.charge({ promptTokens: 1_001, completionTokens: 0 })).toEqual({
      ok: false,
      reason: 'TOKEN_BUDGET_EXCEEDED',
    });
  });

  it('enforces the cost ceiling in integer micro-units and fails closed on unreported usage', () => {
    // 1 000 prompt tokens at 5 USD/M = 5 000 micros; 500 completion at 10 USD/M = 5 000 micros; total 10 000.
    const b = new ModelBudget({ ...limits, maxTotalTokens: 10_000 });
    expect(b.charge({ promptTokens: 1_000, completionTokens: 500 })).toMatchObject({ ok: true, costMicros: 10_000n });
    const c = new ModelBudget({ ...limits, maxTotalTokens: 10_000, maxPromptTokens: 2_000 });
    expect(c.charge({ promptTokens: 1_001, completionTokens: 500 })).toEqual({
      ok: false,
      reason: 'COST_BUDGET_EXCEEDED',
    });
    expect(new ModelBudget(limits).charge({ promptTokens: null, completionTokens: 5 })).toEqual({
      ok: false,
      reason: 'USAGE_UNREPORTED',
    });
  });
});
