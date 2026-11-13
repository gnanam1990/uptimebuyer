// T-052 (chart): the °C grid is bounded however extreme the readings are. A faulty or hostile device can report any
// integer, and the console must not freeze generating grid lines for it (security review of the redesign).
import { describe, expect, it } from 'vitest';
import { gridTicks, MAX_GRID_TICKS } from '../src/views/incident/chartTicks.js';

describe('T-052 chart grid ticks', () => {
  it('ticks every 2 °C (milli-degrees) across a normal cold-room range', () => {
    expect(gridTicks(-500, 10_500)).toEqual([0, 2000, 4000, 6000, 8000, 10_000]);
  });

  it('never produces more than the cap, even for absurd or huge ranges', () => {
    for (const [lo, hi] of [
      [-500, 1e12],
      [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [-2_000_000, 2_000_000],
    ]) {
      const t = gridTicks(lo!, hi!);
      expect(t.length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(MAX_GRID_TICKS);
      for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(2000);
      for (const v of t) expect(v >= lo! && v <= hi!).toBe(true);
    }
  });

  it('returns no ticks for a non-finite or inverted range instead of looping', () => {
    expect(gridTicks(Number.NaN, 10_000)).toEqual([]);
    expect(gridTicks(0, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(gridTicks(10_000, 0)).toEqual([]);
  });
});
