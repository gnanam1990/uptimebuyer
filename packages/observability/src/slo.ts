// SLO tracking against OBSERVABILITY-OPERATIONS §6 (NFR-08). The targets are proposed pilot objectives, not achieved
// claims: this tracker measures them over a bounded window and reports MET, MISSED or INSUFFICIENT_DATA honestly. A
// missed objective becomes a readiness warning (visible degraded state) and the ub_slo_target_missed gauge that the
// slo_target_missed alert reads. The two correctness objectives in §6 (no closure without evidence, no spend beyond
// authority) are invariants enforced and alerted elsewhere, never error-budget trade-offs.
import { DomainError } from '@uptimebuyer/contracts';
import type { HealthCheck } from './health.js';
import type { PlatformMetrics, SLO_NAMES } from './platform-metrics.js';

export type SloName = (typeof SLO_NAMES)[number];
export type SloTarget =
  | { name: SloName; kind: 'LATENCY'; quantile: number; targetMs: number; description: string }
  | { name: SloName; kind: 'AVAILABILITY'; targetRatio: number; description: string };

export const SLO_TARGETS: readonly SloTarget[] = Object.freeze([
  {
    name: 'telemetry_acceptance',
    kind: 'LATENCY',
    quantile: 0.95,
    targetMs: 1_000,
    description: 'telemetry acceptance p95 < 1 s of receipt',
  },
  {
    name: 'incident_opening',
    kind: 'LATENCY',
    quantile: 0.95,
    targetMs: 30_000,
    description: 'incident opening p95 < 30 s after rule maturity',
  },
  { name: 'operator_read', kind: 'LATENCY', quantile: 0.95, targetMs: 500, description: 'operator reads p95 < 500 ms' },
  {
    name: 'policy_evaluation',
    kind: 'LATENCY',
    quantile: 0.95,
    targetMs: 1_000,
    description: 'deterministic policy evaluation p95 < 1 s',
  },
  {
    name: 'notification_dispatch',
    kind: 'LATENCY',
    quantile: 0.95,
    targetMs: 60_000,
    description: 'critical notification dispatch p95 < 60 s',
  },
  {
    name: 'outbox_enqueue',
    kind: 'LATENCY',
    quantile: 0.99,
    targetMs: 10_000,
    description: '99% of outbox events enqueued within 10 s',
  },
  {
    name: 'reconciliation_entry',
    kind: 'LATENCY',
    quantile: 0.99,
    targetMs: 60_000,
    description: '99% of unknown outcomes enter reconciliation within 60 s',
  },
  {
    name: 'api_availability',
    kind: 'AVAILABILITY',
    targetRatio: 0.999,
    description: '99.9% operator API availability',
  },
]);

export interface SloEvaluation {
  name: SloName;
  status: 'MET' | 'MISSED' | 'INSUFFICIENT_DATA';
  samples: number;
  observedMs: number | null;
  observedRatio: number | null;
  target: SloTarget;
}

export class SloTracker {
  private readonly latency = new Map<SloName, number[]>();
  private readonly outcomes = new Map<SloName, boolean[]>();
  private readonly minSamples: number;
  private readonly windowSize: number;

  constructor(opts: { minSamples?: number; windowSize?: number } = {}) {
    this.minSamples = opts.minSamples ?? 20;
    this.windowSize = opts.windowSize ?? 10_000;
  }

  private target(name: string): SloTarget {
    const t = SLO_TARGETS.find((x) => x.name === name);
    if (!t) throw new DomainError('VALIDATION_FAILED', 'Unknown SLO.', { reasonCode: 'UNKNOWN_SLO' });
    return t;
  }

  record(name: string, ms: number): void {
    const t = this.target(name);
    if (t.kind !== 'LATENCY' || !Number.isFinite(ms) || ms < 0) return;
    const list = this.latency.get(t.name) ?? [];
    list.push(ms);
    if (list.length > this.windowSize) list.shift();
    this.latency.set(t.name, list);
  }

  recordOutcome(name: string, ok: boolean): void {
    const t = this.target(name);
    if (t.kind !== 'AVAILABILITY') return;
    const list = this.outcomes.get(t.name) ?? [];
    list.push(ok);
    if (list.length > this.windowSize) list.shift();
    this.outcomes.set(t.name, list);
  }

  samples(name: string): number {
    const t = this.target(name);
    return t.kind === 'LATENCY' ? (this.latency.get(t.name)?.length ?? 0) : (this.outcomes.get(t.name)?.length ?? 0);
  }

  evaluate(): SloEvaluation[] {
    return SLO_TARGETS.map((t) => {
      if (t.kind === 'LATENCY') {
        const list = [...(this.latency.get(t.name) ?? [])].sort((a, b) => a - b);
        if (list.length < this.minSamples)
          return {
            name: t.name,
            status: 'INSUFFICIENT_DATA',
            samples: list.length,
            observedMs: list.length ? list[list.length - 1]! : null,
            observedRatio: null,
            target: t,
          };
        // Nearest-rank quantile.
        const observed = list[Math.max(0, Math.ceil(t.quantile * list.length) - 1)]!;
        return {
          name: t.name,
          status: observed <= t.targetMs ? 'MET' : 'MISSED',
          samples: list.length,
          observedMs: observed,
          observedRatio: null,
          target: t,
        };
      }
      const list = this.outcomes.get(t.name) ?? [];
      if (list.length < this.minSamples)
        return {
          name: t.name,
          status: 'INSUFFICIENT_DATA',
          samples: list.length,
          observedMs: null,
          observedRatio: null,
          target: t,
        };
      const ratio = list.filter(Boolean).length / list.length;
      return {
        name: t.name,
        status: ratio >= t.targetRatio ? 'MET' : 'MISSED',
        samples: list.length,
        observedMs: null,
        observedRatio: ratio,
        target: t,
      };
    });
  }

  /** A readiness check that warns (degraded) while any objective is missed. */
  healthCheck(): HealthCheck {
    return async () => {
      const missed = this.evaluate().filter((e) => e.status === 'MISSED');
      return missed.length === 0
        ? { status: 'pass' }
        : { status: 'warn', detail: `SLO missed: ${missed.map((m) => m.name).join(', ')}` };
    };
  }

  exportTo(p: PlatformMetrics): void {
    for (const e of this.evaluate()) p.sloTargetMissed.set({ slo: e.name }, e.status === 'MISSED' ? 1 : 0);
  }
}
