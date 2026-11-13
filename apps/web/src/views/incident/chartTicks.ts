// Horizontal °C grid for the telemetry chart, in milli-degrees. The step is at least 2 °C and grows with the range so
// there are never more than MAX_GRID_TICKS lines, whatever values a device reports; a non-finite or inverted range
// gives no grid rather than a loop.
export const MAX_GRID_TICKS = 12;
const BASE_STEP = 2000;

export function gridTicks(vmin: number, vmax: number): number[] {
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax < vmin) return [];
  const span = vmax - vmin;
  const step = Math.max(BASE_STEP, Math.ceil(span / MAX_GRID_TICKS / BASE_STEP) * BASE_STEP);
  if (!Number.isFinite(step) || step <= 0) return [];
  const ticks: number[] = [];
  for (let v = Math.ceil(vmin / step) * step; v <= vmax && ticks.length < MAX_GRID_TICKS; v += step)
    ticks.push(v === 0 ? 0 : v);
  return ticks;
}
