// @uptimebuyer/resilience — explicit resource bounds with backpressure (M13, NFR-04, INV-08). Every bound refuses
// explicitly with a typed error and a retry hint; nothing queues without limit, retries without limit or waits without
// a deadline. A retry decision for an operation that may have had an external effect is refused unless a pre-existing
// reconciliation key exists (INV-08: unknown is not failure, and autonomous retry needs authoritative reconciliation).
import { DomainError } from '@uptimebuyer/contracts';

const invalid = (what: string) => new DomainError('VALIDATION_FAILED', `Invalid bound: ${what}.`);

// ---------------------------------------------------------------------------------------------------------------
// Rate

export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly cfg: { capacity: number; refillPerSecond: number },
    private readonly now: () => number = Date.now,
  ) {
    if (!(cfg.capacity >= 1) || !(cfg.refillPerSecond > 0)) throw invalid('token bucket');
    this.tokens = cfg.capacity;
    this.at = now();
  }

  tryTake(n = 1): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    this.tokens = Math.min(this.cfg.capacity, this.tokens + ((t - this.at) / 1000) * this.cfg.refillPerSecond);
    this.at = t;
    if (this.tokens + 1e-9 >= n) {
      this.tokens -= n;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil(((n - this.tokens) / this.cfg.refillPerSecond) * 1000) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency with a bounded queue and explicit load shedding

export interface BulkheadOptions {
  name: string;
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

const shed = (reasonCode: 'LOAD_SHED' | 'QUEUE_TIMEOUT', bound: string, retryAfterMs: number) =>
  new DomainError('RATE_LIMITED', 'The service is at capacity; retry later.', { reasonCode, bound, retryAfterMs });

export class Bulkhead {
  private active = 0;
  private readonly queue: { grant: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(
    private readonly opts: BulkheadOptions,
    private readonly onShed: (bound: string, reason: 'LOAD_SHED' | 'QUEUE_TIMEOUT') => void = () => {},
  ) {
    if (!(opts.maxConcurrent >= 1) || !(opts.maxQueued >= 0) || !(opts.queueTimeoutMs >= 1)) throw invalid('bulkhead');
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  /** Acquire a slot (waiting in the bounded queue at most queueTimeoutMs); returns the release function. */
  acquire(): Promise<() => void> {
    const release = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.active--;
        const next = this.queue.shift();
        if (next) {
          clearTimeout(next.timer);
          next.grant();
        }
      };
    };
    if (this.active < this.opts.maxConcurrent) {
      this.active++;
      return Promise.resolve(release());
    }
    if (this.queue.length >= this.opts.maxQueued) {
      this.onShed(this.opts.name, 'LOAD_SHED');
      return Promise.reject(shed('LOAD_SHED', this.opts.name, this.opts.queueTimeoutMs));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          this.active++;
          resolve(release());
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          this.onShed(this.opts.name, 'QUEUE_TIMEOUT');
          reject(shed('QUEUE_TIMEOUT', this.opts.name, this.opts.queueTimeoutMs));
        }, this.opts.queueTimeoutMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deadlines

export type EffectClass = 'NONE' | 'IDEMPOTENT' | 'EXTERNAL_EFFECT';

/**
 * Run `fn` under a deadline. On expiry the signal aborts and the caller gets a typed outcome: a definite failure for
 * work without external effect, but DEPENDENCY_OUTCOME_UNKNOWN when an external effect may already have happened.
 */
export async function withDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { effect: EffectClass },
): Promise<T> {
  if (!(ms >= 1) || !Number.isFinite(ms)) throw invalid('deadline');
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(
        opts.effect === 'EXTERNAL_EFFECT'
          ? new DomainError('DEPENDENCY_OUTCOME_UNKNOWN', 'The dependency did not answer in time; outcome unknown.', {
              reasonCode: 'DEADLINE_EXCEEDED',
            })
          : new DomainError('DEPENDENCY_FAILED', 'The dependency did not answer in time.', {
              reasonCode: 'DEADLINE_EXCEEDED',
            }),
      );
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Retry decisions

export type RetryDecision =
  { retry: true; delayMs: number } | { retry: false; reason: 'MAX_ATTEMPTS' | 'NO_RECONCILIATION_KEY' | 'TERMINAL' };

export class RetryPolicy {
  constructor(private readonly cfg: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }) {
    if (!(cfg.maxAttempts >= 1) || !(cfg.baseDelayMs >= 0) || !(cfg.maxDelayMs >= cfg.baseDelayMs))
      throw invalid('retry policy');
  }

  /** Decide after `attempt` (1-based) attempts have run. Deterministic (no jitter) so tests and audits reproduce it. */
  decide(input: {
    attempt: number;
    effect: EffectClass;
    reconciliationKey?: string | null;
    terminal?: boolean;
  }): RetryDecision {
    if (input.terminal) return { retry: false, reason: 'TERMINAL' };
    if (
      input.effect === 'EXTERNAL_EFFECT' &&
      !(typeof input.reconciliationKey === 'string' && input.reconciliationKey.length > 0)
    )
      return { retry: false, reason: 'NO_RECONCILIATION_KEY' };
    if (input.attempt >= this.cfg.maxAttempts) return { retry: false, reason: 'MAX_ATTEMPTS' };
    const delayMs = Math.min(this.cfg.maxDelayMs, this.cfg.baseDelayMs * 2 ** Math.max(0, input.attempt - 1));
    return { retry: true, delayMs };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Size

export function assertWithinBytes(body: Uint8Array | string, maxBytes: number): void {
  const n = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
  if (n > maxBytes)
    throw new DomainError('VALIDATION_FAILED', 'Request body is too large.', {
      reasonCode: 'BODY_TOO_LARGE',
      maxBytes,
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Model token and cost budget

export interface ModelBudgetLimits {
  maxPromptTokens: number;
  maxCompletionTokens: number;
  maxTotalTokens: number;
  /** Ceiling in integer micro-units of the pricing currency; null = no cost ceiling. */
  maxCostMicros: bigint | null;
  pricePerMillionPromptMicros?: bigint;
  pricePerMillionCompletionMicros?: bigint;
}

export type ModelCharge =
  | { ok: true; promptTokens: number; completionTokens: number; totalTokens: number; costMicros: bigint | null }
  | { ok: false; reason: 'TOKEN_BUDGET_EXCEEDED' | 'COST_BUDGET_EXCEEDED' | 'USAGE_UNREPORTED' };

/** Cumulative per-run budget. Cost uses ceiling division so a run is never under-charged. */
export class ModelBudget {
  private prompt = 0;
  private completion = 0;

  constructor(private readonly limits: ModelBudgetLimits) {
    if (
      limits.maxCostMicros !== null &&
      (limits.pricePerMillionPromptMicros === undefined || limits.pricePerMillionCompletionMicros === undefined)
    )
      throw invalid('model cost budget without pricing');
  }

  private cost(prompt: number, completion: number): bigint {
    const up = (tokens: number, perMillion: bigint) => (BigInt(tokens) * perMillion + 999_999n) / 1_000_000n;
    return (
      up(prompt, this.limits.pricePerMillionPromptMicros ?? 0n) +
      up(completion, this.limits.pricePerMillionCompletionMicros ?? 0n)
    );
  }

  charge(usage: { promptTokens: number | null; completionTokens: number | null }): ModelCharge {
    const p = usage.promptTokens;
    const c = usage.completionTokens;
    // Unreported usage fails closed: the caller decides whether a conservative estimate may stand in for it.
    if (p === null || c === null || !Number.isInteger(p) || !Number.isInteger(c) || p < 0 || c < 0)
      return { ok: false, reason: 'USAGE_UNREPORTED' };
    const prompt = this.prompt + p;
    const completion = this.completion + c;
    if (
      prompt > this.limits.maxPromptTokens ||
      completion > this.limits.maxCompletionTokens ||
      prompt + completion > this.limits.maxTotalTokens
    )
      return { ok: false, reason: 'TOKEN_BUDGET_EXCEEDED' };
    let costMicros: bigint | null = null;
    if (this.limits.maxCostMicros !== null) {
      costMicros = this.cost(prompt, completion);
      if (costMicros > this.limits.maxCostMicros) return { ok: false, reason: 'COST_BUDGET_EXCEEDED' };
    }
    this.prompt = prompt;
    this.completion = completion;
    return {
      ok: true,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      costMicros,
    };
  }
}
