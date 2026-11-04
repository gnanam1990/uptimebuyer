// Injectable clock (epoch milliseconds). Production uses the system clock; tests drive a manual clock so freshness
// timers, rate buckets and lateness are deterministic.
export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

export class ManualClock implements Clock {
  private ms: number;
  constructor(startMs: number) {
    if (!Number.isSafeInteger(startMs)) throw new Error('ManualClock needs integer epoch milliseconds.');
    this.ms = startMs;
  }
  now(): number {
    return this.ms;
  }
  /** Move forward by `deltaMs` (never backwards) and return the new time. */
  advance(deltaMs: number): number {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) throw new Error('ManualClock only advances.');
    this.ms += deltaMs;
    return this.ms;
  }
  set(ms: number): number {
    if (!Number.isSafeInteger(ms)) throw new Error('ManualClock needs integer epoch milliseconds.');
    this.ms = ms;
    return this.ms;
  }
}
