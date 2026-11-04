// T-016 — Edge reconnect and bounded backfill (unit layer): the versioned lateness policy deterministically
// classifies a sample from its source event time, gateway receipt time and delivery mode. A buffered (BACKFILL)
// delivery is never LIVE whatever its lag; LATE/BACKFILL samples never qualify for a recovery window; simulated
// input can never pass a real-sensor claim.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LATENESS_POLICY,
  LatenessPolicySchema,
  assertPhysicalSensorClaim,
  classifyIngestion,
  isRecoveryQualifying,
  latenessPolicyDigest,
} from '../src/index.js';

const p = DEFAULT_LATENESS_POLICY;
const recv = Date.UTC(2026, 10, 4, 12, 0, 0);

describe('T-016 lateness classification', () => {
  it('is versioned, validated and digest-pinned', () => {
    expect(p.policyVersion).toBe('telemetry-lateness.v1');
    expect(LatenessPolicySchema.safeParse(p).success).toBe(true);
    expect(latenessPolicyDigest(p)).toMatch(/^telemetry-lateness-policy\.v1:sha256:[0-9a-f]{64}$/);
    expect(latenessPolicyDigest({ ...p, liveMaxLagMs: p.liveMaxLagMs + 1 })).not.toBe(latenessPolicyDigest(p));
    expect(LatenessPolicySchema.safeParse({ ...p, lateMaxLagMs: p.liveMaxLagMs - 1 }).success).toBe(false);
  });

  it('classifies live delivery by lag into LIVE, LATE and BACKFILL at the exact policy boundaries', () => {
    const c = (lag: number) => classifyIngestion(recv - lag, recv, 'LIVE', p);
    expect(c(0)).toEqual({ ok: true, ingestionClass: 'LIVE', latenessMs: 0 });
    expect(c(p.liveMaxLagMs)).toEqual({ ok: true, ingestionClass: 'LIVE', latenessMs: p.liveMaxLagMs });
    expect(c(p.liveMaxLagMs + 1).ingestionClass).toBe('LATE');
    expect(c(p.lateMaxLagMs).ingestionClass).toBe('LATE');
    expect(c(p.lateMaxLagMs + 1).ingestionClass).toBe('BACKFILL');
    // small, bounded device clock lead is tolerated and recorded as negative lateness
    expect(c(-p.maxFutureSkewMs)).toEqual({ ok: true, ingestionClass: 'LIVE', latenessMs: -p.maxFutureSkewMs });
  });

  it('rejects future-skewed and too-old source times', () => {
    expect(classifyIngestion(recv + p.maxFutureSkewMs + 1, recv, 'LIVE', p)).toEqual({
      ok: false,
      reasonCode: 'FUTURE_EVENT_TIME',
    });
    expect(classifyIngestion(recv - p.maxAgeMs - 1, recv, 'BACKFILL', p)).toEqual({
      ok: false,
      reasonCode: 'EVENT_OUTSIDE_ACCEPTANCE_WINDOW',
    });
  });

  it('never classifies a buffered delivery as LIVE, whatever the lag', () => {
    for (const lag of [0, 1, p.liveMaxLagMs, p.liveMaxLagMs + 1, p.lateMaxLagMs + 1])
      expect(classifyIngestion(recv - lag, recv, 'BACKFILL', p).ingestionClass).toBe('BACKFILL');
  });

  it('is deterministic: the same inputs always produce the same class', () => {
    for (let lag = -p.maxFutureSkewMs; lag < p.lateMaxLagMs * 2; lag += 7919) {
      const a = classifyIngestion(recv - lag, recv, 'LIVE', p);
      expect(classifyIngestion(recv - lag, recv, 'LIVE', p)).toEqual(a);
    }
  });

  it('only LIVE, flag-free, non-revoked samples qualify for a recovery window', () => {
    const base = { ingestionClass: 'LIVE', qualityFlags: [] as string[], inputOrigin: 'PHYSICAL_SENSOR' } as const;
    expect(isRecoveryQualifying(base)).toBe(true);
    expect(isRecoveryQualifying({ ...base, ingestionClass: 'LATE' })).toBe(false);
    expect(isRecoveryQualifying({ ...base, ingestionClass: 'BACKFILL' })).toBe(false);
    expect(isRecoveryQualifying({ ...base, qualityFlags: ['UNCALIBRATED'] })).toBe(false);
    expect(isRecoveryQualifying({ ...base, qualityFlags: ['OUT_OF_RANGE'] })).toBe(false);
  });

  it('simulated input can never pass a real-sensor claim', () => {
    const physical = { inputOrigin: 'PHYSICAL_SENSOR' } as const;
    const simulated = { inputOrigin: 'SIMULATED_INPUT' } as const;
    expect(() => assertPhysicalSensorClaim([physical, physical])).not.toThrow();
    expect(() => assertPhysicalSensorClaim([physical, simulated])).toThrow(/SIMULATED_INPUT/);
    expect(() => assertPhysicalSensorClaim([])).toThrow();
  });
});
