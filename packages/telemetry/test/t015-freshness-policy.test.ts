// T-015 — Stale and offline health projection (unit layer): with an advancing clock the pure evaluator moves
// FRESH -> STALE -> OFFLINE, never reports stale, missing, invalid or revoked telemetry as healthy, and every view
// carries source time, receipt time, the freshness threshold and a status reason (INV-11).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRESHNESS_POLICY,
  FRESHNESS_STATES,
  FreshnessPolicySchema,
  evaluateFreshness,
  freshnessPolicyDigest,
  rollupFreshness,
} from '../src/index.js';

const p = DEFAULT_FRESHNESS_POLICY;
const t0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const basis = { sourceTime: iso(t0), receiptTime: iso(t0 + 200), invalidReason: null, invalidAt: null };

describe('T-015 freshness evaluation', () => {
  it('is versioned and validated, and the vocabulary has no healthy or recovered state', () => {
    expect(p.policyVersion).toBe('telemetry-freshness.v1');
    expect(FreshnessPolicySchema.safeParse(p).success).toBe(true);
    expect(FreshnessPolicySchema.safeParse({ ...p, offlineAfterMs: p.staleAfterMs }).success).toBe(false);
    expect(freshnessPolicyDigest(p)).toMatch(/^telemetry-freshness-policy\.v1:sha256:[0-9a-f]{64}$/);
    expect([...FRESHNESS_STATES]).toEqual(['FRESH', 'STALE', 'OFFLINE', 'INVALID']);
  });

  it('moves FRESH -> STALE -> OFFLINE as the clock advances, healthy only while FRESH', () => {
    const seen: string[] = [];
    for (let now = t0; now <= t0 + p.offlineAfterMs + 60_000; now += 1_000) {
      const v = evaluateFreshness(basis, now, p);
      if (seen.at(-1) !== v.freshness) seen.push(v.freshness);
      expect(v.healthy).toBe(v.freshness === 'FRESH');
      expect(v.sourceTime).toBe(basis.sourceTime);
      expect(v.receiptTime).toBe(basis.receiptTime);
      expect(v.freshnessThresholdMs).toBe(p.staleAfterMs);
      expect(v.offlineThresholdMs).toBe(p.offlineAfterMs);
      expect(v.statusReason).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    expect(seen).toEqual(['FRESH', 'STALE', 'OFFLINE']);
    expect(evaluateFreshness(basis, t0 + p.staleAfterMs, p).freshness).toBe('FRESH');
    expect(evaluateFreshness(basis, t0 + p.staleAfterMs + 1, p).freshness).toBe('STALE');
    expect(evaluateFreshness(basis, t0 + p.offlineAfterMs + 1, p).freshness).toBe('OFFLINE');
  });

  it('reports missing telemetry as OFFLINE, never healthy', () => {
    const v = evaluateFreshness({ sourceTime: null, receiptTime: null, invalidReason: null, invalidAt: null }, t0, p);
    expect(v).toMatchObject({ freshness: 'OFFLINE', healthy: false, statusReason: 'NO_LIVE_TELEMETRY' });
    expect(v.sourceTime).toBeNull();
    expect(v.freshnessThresholdMs).toBe(p.staleAfterMs);
  });

  it('reports an invalidating observation at or after the last good sample as INVALID with its reason', () => {
    const inv = { ...basis, invalidReason: 'QUALITY_OUT_OF_RANGE', invalidAt: iso(t0 + 1) };
    expect(evaluateFreshness(inv, t0 + 2, p)).toMatchObject({
      freshness: 'INVALID',
      healthy: false,
      statusReason: 'QUALITY_OUT_OF_RANGE',
    });
    // an older invalidation is superseded by a newer good LIVE sample
    const older = { ...basis, invalidReason: 'BINDING_MISSING', invalidAt: iso(t0 - 1) };
    expect(evaluateFreshness(older, t0 + 2, p).freshness).toBe('FRESH');
  });

  it('reports a revoked device and a source time ahead of the clock as INVALID', () => {
    expect(evaluateFreshness({ ...basis, deviceRevoked: true }, t0 + 1, p)).toMatchObject({
      freshness: 'INVALID',
      healthy: false,
      statusReason: 'DEVICE_REVOKED',
    });
    expect(evaluateFreshness(basis, t0 - p.maxFutureSkewMs - 1, p)).toMatchObject({
      freshness: 'INVALID',
      statusReason: 'SOURCE_TIME_AHEAD_OF_CLOCK',
    });
  });

  it('rolls a device up to its worst channel, and a device without channels is never healthy', () => {
    const fresh = evaluateFreshness(basis, t0 + 1, p);
    const stale = evaluateFreshness(basis, t0 + p.staleAfterMs + 1, p);
    expect(rollupFreshness([fresh, stale], p).freshness).toBe('STALE');
    expect(rollupFreshness([fresh, stale], p).healthy).toBe(false);
    expect(rollupFreshness([fresh], p).healthy).toBe(true);
    expect(rollupFreshness([], p)).toMatchObject({ freshness: 'OFFLINE', healthy: false, statusReason: 'NO_CHANNELS' });
  });
});
