// Versioned, digest-pinned telemetry policies (HARDWARE-IOT §5–6, TDD §6, INV-11).
// Lateness: immutable LIVE | LATE | BACKFILL classification from source event time, gateway receipt time and the
// delivery mode; a buffered delivery is never LIVE. Freshness: FRESH | STALE | OFFLINE | INVALID from the newest LIVE
// flag-free sample, kept separate from ingestion class and quality. There is no healthy or recovered state: `healthy`
// is a derived display flag that is true only for FRESH.
import { canonicalDigest } from '@uptimebuyer/domain';
import { z } from 'zod';
import type { DeliveryMode, IngestionClass, InputOrigin, QualityFlag } from './protocol.js';

const Ms = z
  .int()
  .min(1)
  .max(366 * 24 * 3600 * 1000);

export const LatenessPolicySchema = z
  .strictObject({
    policyVersion: z.string().regex(/^telemetry-lateness\.v[1-9][0-9]*$/),
    /** A live delivery at most this late is LIVE. */
    liveMaxLagMs: Ms,
    /** A live delivery later than liveMaxLagMs and at most this late is LATE; anything later is BACKFILL. */
    lateMaxLagMs: Ms,
    /** Tolerated device clock lead; a source time further ahead is rejected. */
    maxFutureSkewMs: Ms,
    /** Oldest accepted source time (acceptance window for backfill). */
    maxAgeMs: Ms,
  })
  .refine((p) => p.lateMaxLagMs > p.liveMaxLagMs, { path: ['lateMaxLagMs'], message: 'Must exceed liveMaxLagMs.' })
  .refine((p) => p.maxAgeMs > p.lateMaxLagMs, { path: ['maxAgeMs'], message: 'Must exceed lateMaxLagMs.' });
export type LatenessPolicy = z.output<typeof LatenessPolicySchema>;

export const DEFAULT_LATENESS_POLICY: LatenessPolicy = Object.freeze({
  policyVersion: 'telemetry-lateness.v1',
  liveMaxLagMs: 30_000,
  lateMaxLagMs: 600_000,
  maxFutureSkewMs: 5_000,
  maxAgeMs: 7 * 24 * 3600 * 1000,
});

export const latenessPolicyDigest = (p: LatenessPolicy): string =>
  canonicalDigest('telemetry-lateness-policy', 1, LatenessPolicySchema.parse(p));

export type Classification =
  | { ok: true; ingestionClass: IngestionClass; latenessMs: number }
  | { ok: false; reasonCode: 'FUTURE_EVENT_TIME' | 'EVENT_OUTSIDE_ACCEPTANCE_WINDOW'; ingestionClass?: never };

/** Deterministic: the same (eventAt, receivedAt, delivery, policy) always yields the same class. */
export function classifyIngestion(
  eventAtMs: number,
  receivedAtMs: number,
  delivery: DeliveryMode,
  policy: LatenessPolicy,
): Classification {
  const lag = receivedAtMs - eventAtMs;
  if (lag < -policy.maxFutureSkewMs) return { ok: false, reasonCode: 'FUTURE_EVENT_TIME' };
  if (lag > policy.maxAgeMs) return { ok: false, reasonCode: 'EVENT_OUTSIDE_ACCEPTANCE_WINDOW' };
  if (delivery === 'BACKFILL') return { ok: true, ingestionClass: 'BACKFILL', latenessMs: lag };
  if (lag <= policy.liveMaxLagMs) return { ok: true, ingestionClass: 'LIVE', latenessMs: lag };
  if (lag <= policy.lateMaxLagMs) return { ok: true, ingestionClass: 'LATE', latenessMs: lag };
  return { ok: true, ingestionClass: 'BACKFILL', latenessMs: lag };
}

// ---------------------------------------------------------------------------------------------------------------
// Freshness

export const FRESHNESS_STATES = Object.freeze(['FRESH', 'STALE', 'OFFLINE', 'INVALID'] as const);
export type Freshness = (typeof FRESHNESS_STATES)[number];
const SEVERITY: Record<Freshness, number> = { FRESH: 0, STALE: 1, OFFLINE: 2, INVALID: 3 };
export const freshnessSeverity = (f: Freshness): number => SEVERITY[f];

export const FreshnessPolicySchema = z
  .strictObject({
    policyVersion: z.string().regex(/^telemetry-freshness\.v[1-9][0-9]*$/),
    /** Newest LIVE sample older than this is STALE (the freshness threshold exposed on every projection). */
    staleAfterMs: Ms,
    /** Newest LIVE sample older than this is OFFLINE. */
    offlineAfterMs: Ms,
    /** A basis source time further ahead of the evaluation clock than this is INVALID. */
    maxFutureSkewMs: Ms,
  })
  .refine((p) => p.offlineAfterMs > p.staleAfterMs, { path: ['offlineAfterMs'], message: 'Must exceed staleAfterMs.' });
export type FreshnessPolicy = z.output<typeof FreshnessPolicySchema>;

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = Object.freeze({
  policyVersion: 'telemetry-freshness.v1',
  staleAfterMs: 120_000,
  offlineAfterMs: 600_000,
  maxFutureSkewMs: 5_000,
});

export const freshnessPolicyDigest = (p: FreshnessPolicy): string =>
  canonicalDigest('telemetry-freshness-policy', 1, FreshnessPolicySchema.parse(p));

export interface FreshnessBasis {
  /** Source event time of the newest LIVE, flag-free sample (null when none). */
  sourceTime: string | null;
  /** Gateway receipt time of that sample. */
  receiptTime: string | null;
  /** Most recent invalidating observation (quality flag, broken binding) and its source time. */
  invalidReason: string | null;
  invalidAt: string | null;
  deviceRevoked?: boolean;
  channelRetired?: boolean;
}

export interface FreshnessView {
  freshness: Freshness;
  statusReason: string;
  healthy: boolean;
  sourceTime: string | null;
  receiptTime: string | null;
  freshnessThresholdMs: number;
  offlineThresholdMs: number;
  ageMs: number | null;
  evaluatedAt: string;
  freshnessPolicyVersion: string;
}

export function evaluateFreshness(basis: FreshnessBasis, nowMs: number, policy: FreshnessPolicy): FreshnessView {
  const view = (freshness: Freshness, statusReason: string, ageMs: number | null): FreshnessView => ({
    freshness,
    statusReason,
    healthy: freshness === 'FRESH',
    sourceTime: basis.sourceTime,
    receiptTime: basis.receiptTime,
    freshnessThresholdMs: policy.staleAfterMs,
    offlineThresholdMs: policy.offlineAfterMs,
    ageMs,
    evaluatedAt: new Date(nowMs).toISOString(),
    freshnessPolicyVersion: policy.policyVersion,
  });
  const source = basis.sourceTime === null ? null : Date.parse(basis.sourceTime);
  const age = source === null ? null : nowMs - source;
  if (basis.deviceRevoked) return view('INVALID', 'DEVICE_REVOKED', age);
  if (basis.channelRetired) return view('INVALID', 'CHANNEL_RETIRED', age);
  if (
    basis.invalidReason !== null &&
    (source === null || basis.invalidAt === null || Date.parse(basis.invalidAt) >= source)
  )
    return view('INVALID', basis.invalidReason, age);
  if (source === null || age === null || !Number.isFinite(age)) return view('OFFLINE', 'NO_LIVE_TELEMETRY', null);
  if (age < -policy.maxFutureSkewMs) return view('INVALID', 'SOURCE_TIME_AHEAD_OF_CLOCK', age);
  if (age > policy.offlineAfterMs) return view('OFFLINE', 'LIVE_TELEMETRY_OVERDUE_OFFLINE', age);
  if (age > policy.staleAfterMs) return view('STALE', 'LIVE_TELEMETRY_OVERDUE', age);
  return view('FRESH', 'LIVE_TELEMETRY_WITHIN_THRESHOLD', age);
}

/** Device rollup: the worst channel (ties: the oldest source time). A device without channels is OFFLINE. */
export function rollupFreshness(channels: readonly FreshnessView[], policy: FreshnessPolicy): FreshnessView {
  if (channels.length === 0)
    return {
      freshness: 'OFFLINE',
      statusReason: 'NO_CHANNELS',
      healthy: false,
      sourceTime: null,
      receiptTime: null,
      freshnessThresholdMs: policy.staleAfterMs,
      offlineThresholdMs: policy.offlineAfterMs,
      ageMs: null,
      evaluatedAt: new Date().toISOString(),
      freshnessPolicyVersion: policy.policyVersion,
    };
  const worst = [...channels].sort(
    (a, b) =>
      SEVERITY[b.freshness] - SEVERITY[a.freshness] ||
      (a.sourceTime === null ? -1 : b.sourceTime === null ? 1 : a.sourceTime.localeCompare(b.sourceTime)),
  )[0]!;
  return { ...worst, healthy: channels.every((c) => c.healthy) && worst.healthy };
}

// ---------------------------------------------------------------------------------------------------------------
// Recovery and real-input guards (consumed by M04/M11)

/** A sample may count toward a recovery stable window only if LIVE and flag-free (INV-01, HARDWARE-IOT §6). */
export function isRecoveryQualifying(s: {
  ingestionClass: IngestionClass;
  qualityFlags: readonly (QualityFlag | string)[];
  inputOrigin?: InputOrigin;
}): boolean {
  return s.ingestionClass === 'LIVE' && s.qualityFlags.length === 0;
}

/** A physical-sensor claim (FR-22) requires a non-empty sample set with no simulated input. */
export function assertPhysicalSensorClaim(samples: readonly { inputOrigin: InputOrigin }[]): void {
  if (samples.length === 0) throw new Error('A physical-sensor claim needs at least one sample.');
  if (samples.some((s) => s.inputOrigin !== 'PHYSICAL_SENSOR'))
    throw new Error('Samples labelled SIMULATED_INPUT cannot support a physical-sensor claim.');
}
