// T-056 test-only fault seam at the transaction boundary: a pg.Pool stand-in that forwards to the real pool but fails
// a chosen statement (before or after it executes) or, once tripped, every later statement — the observable effect of
// the process or its database connection dying at that point (SQLSTATE 57P01, admin_shutdown). An error before COMMIT
// rolls the transaction back exactly as a dead connection would; an error after COMMIT is a lost response. ROLLBACK
// and release always pass through so the harness never leaks connections. No product code knows this exists.
import type pg from 'pg';

export interface FaultRule {
  /** Statement text to match (first argument of query). */
  match: RegExp;
  /** 'before': the statement never runs; 'after': it runs, then the caller sees the failure. */
  phase: 'before' | 'after';
  /** 1-based occurrence of the match that fails (default 1). */
  nth?: number;
  /** After firing, trip the pool so every later statement fails too (the process is gone). */
  tripAfter?: boolean;
}

const killed = () =>
  Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });

const sqlOf = (args: unknown[]): string => {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && 'text' in a) return String((a as { text: unknown }).text);
  return '';
};

export class FaultyPool {
  readonly fired: string[] = [];
  private tripped = false;
  private readonly seen = new Map<FaultRule, number>();

  constructor(
    private readonly inner: pg.Pool,
    private readonly rules: FaultRule[] = [],
  ) {}

  /** Every later statement fails (except ROLLBACK). */
  trip(): void {
    this.tripped = true;
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  private async run<T>(sql: string, exec: () => Promise<T>): Promise<T> {
    if (/^\s*ROLLBACK\b/i.test(sql)) return exec();
    if (this.tripped) throw killed();
    for (const rule of this.rules) {
      if (!rule.match.test(sql)) continue;
      const n = (this.seen.get(rule) ?? 0) + 1;
      this.seen.set(rule, n);
      if (n !== (rule.nth ?? 1)) continue;
      this.fired.push(`${rule.phase}:${rule.match.source}`);
      if (rule.phase === 'before') {
        if (rule.tripAfter) this.tripped = true;
        throw killed();
      }
      await exec();
      if (rule.tripAfter) this.tripped = true;
      throw killed();
    }
    return exec();
  }

  query(...args: unknown[]): Promise<pg.QueryResult> {
    return this.run(sqlOf(args), () => (this.inner.query as (...a: unknown[]) => Promise<pg.QueryResult>)(...args));
  }

  async connect(): Promise<pg.PoolClient> {
    if (this.tripped) throw killed();
    const client = await this.inner.connect();
    const run = this.run.bind(this);
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query')
          return (...args: unknown[]) =>
            run(sqlOf(args), () => (target.query as (...a: unknown[]) => Promise<pg.QueryResult>).apply(target, args));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  on(): this {
    return this;
  }

  /** The stand-in as the pool type the packages expect. */
  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}
