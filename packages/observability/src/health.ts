// Liveness and readiness (NFR-08, NFR-09). Readiness aggregates named, time-bounded checks: any critical failure is
// `unavailable` (the instance must not take traffic), a warning or a non-critical failure is `degraded` (visible, never
// hidden as healthy), all passing is `ready`. A check that throws or exceeds its deadline fails without exposing its
// error text, which could carry connection strings or credentials.

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult {
  status: CheckStatus;
  detail?: string;
}
export type HealthCheck = () => Promise<CheckResult>;

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'unavailable';
  checks: { name: string; status: CheckStatus; critical: boolean; detail?: string }[];
}

const DETAIL = /^[A-Za-z0-9 _.,:;=<>%()/+-]{0,300}$/;

export class HealthRegistry {
  private readonly checks = new Map<string, { fn: HealthCheck; critical: boolean }>();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2_000;
  }

  register(name: string, fn: HealthCheck, opts: { critical: boolean }): void {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error('invalid check name');
    this.checks.set(name, { fn, critical: opts.critical });
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  live(): { status: 'live' } {
    return { status: 'live' };
  }

  async ready(): Promise<ReadinessReport> {
    const results = await Promise.all(
      [...this.checks.entries()].map(async ([name, { fn, critical }]) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<CheckResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'fail', detail: 'TIMEOUT' }), this.timeoutMs);
          timer.unref?.();
        });
        let r: CheckResult;
        try {
          r = await Promise.race([fn(), timeout]);
        } catch {
          r = { status: 'fail', detail: 'CHECK_FAILED' };
        } finally {
          if (timer) clearTimeout(timer);
        }
        const status: CheckStatus = r.status === 'pass' || r.status === 'warn' ? r.status : 'fail';
        const detail = typeof r.detail === 'string' && DETAIL.test(r.detail) ? r.detail : undefined;
        return { name, status, critical, ...(detail !== undefined ? { detail } : {}) };
      }),
    );
    const status: ReadinessReport['status'] = results.some((c) => c.critical && c.status === 'fail')
      ? 'unavailable'
      : results.some((c) => c.status !== 'pass')
        ? 'degraded'
        : 'ready';
    return { status, checks: results };
  }
}
