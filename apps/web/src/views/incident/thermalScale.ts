// The faceplate thermal scale (docs/design/studio/BRIEF.md): the newest reading placed against the pinned threshold on
// a °C scale. It is a visual duplicate of text the faceplate already states (value, freshness, threshold), so it is
// hidden from assistive technology; its honesty rules are the readout's (./readout.ts) and are unit-tested here:
// - "live" only when the readout itself is live (FRESH, latest refresh succeeded, not paused, not simulated);
// - "simulated" for a FRESH simulator value (drawn hatched, like the SIMULATED_INPUT tag), never live;
// - "held" for anything else: last-known, stale, paused or after a failed refresh (drawn grey and hatched).
// The scale's range and ticks are bounded for any reported value (the same grid rule as the chart, ./chartTicks.ts).
import { gridTicks } from './chartTicks.js';
import type { ReadoutModel } from './readout.js';

export type ScaleState = 'live' | 'simulated' | 'held';

export interface ScaleModel {
  state: ScaleState;
  /** Scale ends in milli-degrees Celsius. */
  lo: number;
  hi: number;
  /** Position of the newest reading along the scale, 0..1. */
  at: number;
  /** Position of the pinned threshold along the scale, 0..1. */
  thresholdAt: number;
  /** The danger zone lies above or below the threshold, following its comparator. */
  danger: 'above' | 'below';
  beyond: boolean;
  /** Tick positions 0..1 (at most MAX_GRID_TICKS). */
  ticks: number[];
}

const STEP = 2000;

/** How a reading may be drawn: backlit only when live; a fresh simulator value as simulated; anything else as held. */
export function readingState(m: ReadoutModel): ScaleState {
  const fresh = m.freshness === 'FRESH' && m.refreshError === null;
  return m.live ? 'live' : m.simulated && fresh ? 'simulated' : 'held';
}

export function scaleModel(m: ReadoutModel): ScaleModel | null {
  if (!m.last || !m.threshold) return null;
  const v = m.last.valueInt;
  const t = m.threshold.thresholdInt;
  if (!Number.isFinite(v) || !Number.isFinite(t)) return null;
  const lo = Math.floor((Math.min(v, t, 0) - STEP) / STEP) * STEP;
  const hi = Math.ceil((Math.max(v, t) + 2 * STEP) / STEP) * STEP;
  const span = Math.max(1, hi - lo);
  const at = (x: number) => Math.min(1, Math.max(0, (x - lo) / span));
  return {
    state: readingState(m),
    lo,
    hi,
    at: at(v),
    thresholdAt: at(t),
    danger: m.threshold.comparator === 'BELOW' ? 'below' : 'above',
    beyond: m.beyond !== null,
    ticks: gridTicks(lo, hi).map(at),
  };
}
