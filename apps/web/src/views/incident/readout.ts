// The incident faceplate's temperature readout (INV-11). One selection rule shared with the Telemetry panel: the first
// device and its TEMPERATURE series (or its first series). A reading is presented as current only while the signal is
// FRESH and the latest refresh succeeded; after a failed refresh the retained value is the last known one, the error is
// carried, and the retained freshness is not shown (a FRESH tag from stale data would be a false claim).
// Pure and framework-free so the honesty rules are unit-tested (apps/web/test/t051-readout-*.test.ts).
import type { Telemetry } from '@uptimebuyer/api-client';

type Device = Telemetry['devices'][number];
type Series = Device['series'][number];
type Sample = Series['samples'][number];

export interface Reading {
  device: Device | null;
  series: Series | null;
  samples: Sample[];
  last: Sample | null;
  threshold: Telemetry['threshold'];
}

export function selectReading(telemetry: Telemetry | null | undefined): Reading {
  const device = telemetry?.devices[0] ?? null;
  const series = device ? (device.series.find((s) => s.kind === 'TEMPERATURE') ?? device.series[0] ?? null) : null;
  const samples = series?.samples ?? [];
  return { device, series, samples, last: samples.at(-1) ?? null, threshold: telemetry?.threshold ?? null };
}

export interface ReadoutModel {
  label: string;
  last: Sample | null;
  /** Styled and worded as a current reading. */
  live: boolean;
  /** The freshness to show as a tag, or null when it must not be shown (after a failed refresh). */
  freshness: string | null;
  refreshError: string | null;
  /** The newest value is beyond the pinned threshold in the threshold's direction. */
  beyond: 'ABOVE' | 'BELOW' | null;
  threshold: Telemetry['threshold'];
}

export function readoutModel({
  telemetry,
  freshness,
  paused,
  refreshError,
}: {
  telemetry: Telemetry | null;
  freshness: string | null;
  paused: boolean;
  refreshError: string | null;
}): ReadoutModel {
  const { last, threshold } = selectReading(telemetry);
  const failed = refreshError !== null;
  const fresh = freshness === 'FRESH' && !failed;
  const beyond =
    last && threshold
      ? threshold.comparator === 'ABOVE'
        ? last.valueInt > threshold.thresholdInt
          ? 'ABOVE'
          : null
        : last.valueInt < threshold.thresholdInt
          ? 'BELOW'
          : null
      : null;
  const label = !last
    ? 'Temperature'
    : !fresh
      ? 'Last known temperature, not live'
      : paused
        ? 'Newest temperature, live updates paused'
        : 'Newest temperature';
  return {
    label,
    last,
    live: fresh && !paused,
    freshness: failed ? null : freshness,
    refreshError,
    beyond,
    threshold,
  };
}
