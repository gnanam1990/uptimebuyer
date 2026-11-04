// Periodic freshness sweeper (FR-02, INV-11): persists FRESH -> STALE -> OFFLINE (and revocation) transitions and
// emits telemetry.stale.v1 even when a device has gone silent. Reads never depend on it (they re-evaluate against
// the clock), so a stopped sweeper can delay events but never makes stale data look healthy.
import type { UtcInstant } from '@uptimebuyer/contracts';
import { sweepTelemetryFreshness, type Db, type FreshnessTransition } from '@uptimebuyer/data';
import { systemClock, type Clock } from '@uptimebuyer/telemetry';

export interface FreshnessSweeperOptions {
  pool: Db;
  clock?: Clock;
  intervalMs?: number;
  batchSize?: number;
  onTransitions?: (t: FreshnessTransition[]) => void;
  onError?: (e: unknown) => void;
}

export function startFreshnessSweeper(opts: FreshnessSweeperOptions): { stop(): Promise<void> } {
  const clock = opts.clock ?? systemClock;
  const interval = Math.max(opts.intervalMs ?? 15_000, 100);
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = sweepTelemetryFreshness(opts.pool, {
      now: new Date(clock.now()).toISOString() as UtcInstant,
      limit: opts.batchSize ?? 500,
    })
      .then((r) => {
        if (r.transitions.length > 0) opts.onTransitions?.(r.transitions);
      })
      .catch((e: unknown) => opts.onError?.(e))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
