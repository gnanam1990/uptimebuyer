// T-045 — Stable sensor recovery window (pure evaluator; FR-15, INV-01, INV-11). The policy-designated milestone froze
// `observation_boundary_at`; only exact-revision, LIVE, flag-free, physical, in-range samples with source event time
// STRICTLY after the boundary form the continuous window, and it must end in a currently fresh tail. Boundary-equal,
// pre-work, late, backfilled (including backfill followed by a fresh tail), revision-mismatched, wrong-asset,
// sibling-incident, gapped, stale and excursion cases fail or reset; nothing here reads a wall clock.
import { describe, expect, it } from 'vitest';
import { evaluateStableWindow, type WindowPin, type WindowSample, type WindowSpec } from '../src/index.js';

const B = Date.UTC(2026, 10, 5, 12, 0, 0, 0);
const PIN: WindowPin = {
  channelId: 'chn_cabinet-0001',
  channelRevisionId: 'chr_cabinet-r1-0001',
  deviceAssignmentId: 'dasg_cabinet-0001',
  assetId: 'ast_cabinet-0001',
  assetRevisionId: 'arv_cabinet-r1-0001',
};

function spec(over: Partial<WindowSpec> = {}): WindowSpec {
  return {
    incidentId: 'inc_window-0001',
    boundaryAtMs: B,
    asOfMs: B + 61_000,
    stableWindowMs: 60_000,
    maxGapMs: 20_000,
    minSamples: 4,
    maxTailAgeMs: 30_000,
    maxFutureSkewMs: 5_000,
    allowSimulatedInput: false,
    safe: { comparator: 'ABOVE', thresholdInt: 8_000n, hysteresisInt: 500n },
    pins: [PIN],
    ...over,
  };
}

let n = 0;
function s(atMs: number, over: Partial<WindowSample> = {}): WindowSample {
  return {
    id: `tsm_window-${String(++n).padStart(4, '0')}`,
    eventAtMs: atMs,
    ...PIN,
    ingestionClass: 'LIVE',
    delivery: 'LIVE',
    qualityFlags: [],
    inputOrigin: 'PHYSICAL_SENSOR',
    valueInt: 4_000n,
    linkedIncidentIds: [],
    ...over,
  };
}

/** Samples every 10 s from `startMs` to `endMs` inclusive. */
const run = (startMs: number, endMs: number, over: Partial<WindowSample> = {}) => {
  const out: WindowSample[] = [];
  for (let t = startMs; t <= endMs; t += 10_000) out.push(s(t, over));
  return out;
};

describe('T-045 stable sensor recovery window (pure evaluator)', () => {
  it('passes a continuous LIVE in-range window strictly after the boundary ending in a fresh tail', () => {
    const samples = run(B + 1, B + 60_001);
    const r = evaluateStableWindow(spec(), samples);
    expect(r.passed).toBe(true);
    if (!r.passed) return;
    expect(r.sampleCount).toBe(7);
    expect(r.sampleIds).toEqual(samples.map((x) => x.id));
    expect(r.firstAtMs).toBe(B + 1);
    expect(r.lastAtMs).toBe(B + 60_001);
    expect(r.stableMs).toBe(60_000);
  });

  it('a sample at exactly the boundary never qualifies (equality fails)', () => {
    const r = evaluateStableWindow(spec({ asOfMs: B + 60_000 }), run(B, B + 60_000));
    expect(r.passed).toBe(false);
    expect(r.reasonCodes).toEqual(expect.arrayContaining(['BOUNDARY_EQUAL_SAMPLE', 'WINDOW_TOO_SHORT']));
    // One more post-boundary sample completes the window without the boundary-equal one.
    const ok = evaluateStableWindow(spec({ asOfMs: B + 70_000 }), run(B, B + 70_000));
    expect(ok.passed).toBe(true);
    if (ok.passed) expect(ok.firstAtMs).toBe(B + 10_000);
  });

  it('pre-work samples (at or before the boundary) never count toward the window', () => {
    const r = evaluateStableWindow(spec({ asOfMs: B }), run(B - 120_000, B));
    expect(r.passed).toBe(false);
    expect(r.reasonCodes).toContain('NO_POST_BOUNDARY_SAMPLE');
  });

  it('a LATE or BACKFILL sample resets the window; backfill plus a fresh LIVE tail fails', () => {
    const late = run(B + 1, B + 60_001);
    late[3] = { ...late[3]!, ingestionClass: 'LATE' };
    const r1 = evaluateStableWindow(spec(), late);
    expect(r1.passed).toBe(false);
    expect(r1.reasonCodes).toEqual(expect.arrayContaining(['NON_LIVE_SAMPLE', 'WINDOW_TOO_SHORT']));

    const mixed = [
      ...run(B + 1, B + 40_001, { ingestionClass: 'BACKFILL', delivery: 'BACKFILL' }),
      ...run(B + 50_001, B + 60_001),
    ];
    const r2 = evaluateStableWindow(spec(), mixed);
    expect(r2.passed).toBe(false);
    expect(r2.reasonCodes).toEqual(expect.arrayContaining(['NON_LIVE_SAMPLE', 'WINDOW_TOO_SHORT']));

    // A buffered delivery is never LIVE even if mislabelled.
    const lying = run(B + 1, B + 60_001, { delivery: 'BACKFILL' });
    expect(evaluateStableWindow(spec(), lying).passed).toBe(false);
  });

  it('a stale tail fails even over an otherwise perfect window', () => {
    const r = evaluateStableWindow(spec({ asOfMs: B + 60_001 + 30_001 }), run(B + 1, B + 60_001));
    expect(r.passed).toBe(false);
    expect(r.reasonCodes).toContain('TAIL_STALE');
  });

  it('a gap beyond policy or a safe-range excursion resets the window', () => {
    const gapped = [...run(B + 1, B + 20_001), ...run(B + 45_001, B + 75_001)];
    const g = evaluateStableWindow(spec({ asOfMs: B + 75_001 }), gapped);
    expect(g.passed).toBe(false);
    expect(g.reasonCodes).toEqual(expect.arrayContaining(['GAP_EXCEEDED', 'WINDOW_TOO_SHORT']));

    const spike = run(B + 1, B + 60_001);
    spike[4] = { ...spike[4]!, valueInt: 7_501n };
    const e = evaluateStableWindow(spec(), spike);
    expect(e.passed).toBe(false);
    expect(e.reasonCodes).toContain('SAFE_RANGE_EXCURSION');
    // Hysteresis: exactly threshold - hysteresis is safe.
    expect(evaluateStableWindow(spec(), run(B + 1, B + 60_001, { valueInt: 7_500n })).passed).toBe(true);
    // BELOW rules invert the safe side.
    const below = spec({ safe: { comparator: 'BELOW', thresholdInt: -18_000n, hysteresisInt: 1_000n } });
    expect(evaluateStableWindow(below, run(B + 1, B + 60_001, { valueInt: -17_000n })).passed).toBe(true);
    expect(evaluateStableWindow(below, run(B + 1, B + 60_001, { valueInt: -17_001n })).passed).toBe(false);
  });

  it('samples on a superseded channel/assignment/asset revision, another asset or a sibling incident do not qualify', () => {
    for (const over of [
      { channelRevisionId: 'chr_cabinet-r2-0001' },
      { deviceAssignmentId: 'dasg_rebound-0002' },
      { assetRevisionId: 'arv_cabinet-r2-0001' },
      { assetId: 'ast_other-0002' },
    ] satisfies Partial<WindowSample>[]) {
      const r = evaluateStableWindow(spec(), run(B + 1, B + 60_001, over));
      expect(r.passed, JSON.stringify(over)).toBe(false);
      expect(r.reasonCodes).toContain('REVISION_MISMATCH');
    }
    const other = evaluateStableWindow(spec(), run(B + 1, B + 60_001, { channelId: 'chn_other-0002' }));
    expect(other.passed).toBe(false);
    expect(other.reasonCodes).toContain('NO_POST_BOUNDARY_SAMPLE');

    const sibling = run(B + 1, B + 60_001);
    sibling[2] = { ...sibling[2]!, linkedIncidentIds: ['inc_sibling-0002'] };
    const r = evaluateStableWindow(spec(), sibling);
    expect(r.passed).toBe(false);
    expect(r.reasonCodes).toContain('SIBLING_INCIDENT_SAMPLE');
    // Linked to THIS incident is fine.
    const own = run(B + 1, B + 60_001, { linkedIncidentIds: ['inc_window-0001'] });
    expect(evaluateStableWindow(spec(), own).passed).toBe(true);
  });

  it('quality-flagged, simulated, future-dated and too-few samples fail closed', () => {
    expect(evaluateStableWindow(spec(), run(B + 1, B + 60_001, { qualityFlags: ['UNCALIBRATED'] })).passed).toBe(false);
    const sim = evaluateStableWindow(spec(), run(B + 1, B + 60_001, { inputOrigin: 'SIMULATED_INPUT' }));
    expect(sim.passed).toBe(false);
    expect(sim.reasonCodes).toContain('SIMULATED_INPUT');
    expect(
      evaluateStableWindow(
        spec({ allowSimulatedInput: true }),
        run(B + 1, B + 60_001, { inputOrigin: 'SIMULATED_INPUT' }),
      ).passed,
    ).toBe(true);
    const future = evaluateStableWindow(spec({ asOfMs: B + 40_001 }), run(B + 1, B + 60_001));
    expect(future.passed).toBe(false);
    expect(future.reasonCodes).toContain('FUTURE_SAMPLE');
    const sparse = evaluateStableWindow(spec({ minSamples: 8 }), run(B + 1, B + 60_001));
    expect(sparse.passed).toBe(false);
    expect(sparse.reasonCodes).toContain('TOO_FEW_SAMPLES');
    expect(evaluateStableWindow(spec({ pins: [] }), run(B + 1, B + 60_001)).reasonCodes).toContain('NO_PINNED_CHANNEL');
  });

  it('every pinned channel must hold the window independently', () => {
    const pin2: WindowPin = { ...PIN, channelId: 'chn_return-0002', channelRevisionId: 'chr_return-r1-0002' };
    const both = spec({ pins: [PIN, pin2] });
    const only1 = run(B + 1, B + 60_001);
    expect(evaluateStableWindow(both, only1).passed).toBe(false);
    const all = [
      ...only1,
      ...run(B + 1, B + 60_001, { channelId: pin2.channelId, channelRevisionId: pin2.channelRevisionId }),
    ];
    const r = evaluateStableWindow(both, all);
    expect(r.passed).toBe(true);
    if (r.passed) expect(r.sampleCount).toBe(14);
  });

  it('is deterministic and order-independent', () => {
    const samples = run(B + 1, B + 60_001);
    const a = evaluateStableWindow(spec(), samples);
    const b = evaluateStableWindow(spec(), [...samples].reverse());
    expect(b).toEqual(a);
  });
});
