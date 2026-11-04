// Unit normalization against the channel revision effective at source time (CORE-CONTRACT money and measurement
// rules): temperature becomes exact integer milli-°C via the contracts' rational conversion (source value and unit
// retained, rounding labelled), the revision's calibration offset is applied separately from the raw value, and
// physically implausible readings are flagged OUT_OF_RANGE rather than silently dropped.
import { formatScaled, temperatureFromSource, type TemperatureUnit } from '@uptimebuyer/contracts';
import type { QualityFlag, WireUnit } from './protocol.js';

export type ChannelKind = 'TEMPERATURE' | 'CURRENT' | 'POWER' | 'DOOR' | 'HEARTBEAT';

export interface ChannelRevisionView {
  kind: ChannelKind;
  unit: string;
  sourceUnit: TemperatureUnit | null;
  calibrationOffsetMilli: number;
}

/** Plausibility bounds per kind in canonical units (milli-°C, mA, mW, boolean, none). */
export const PLAUSIBLE_RANGE: Readonly<Record<ChannelKind, readonly [number, number]>> = Object.freeze({
  TEMPERATURE: [-100_000, 150_000],
  CURRENT: [0, 200_000],
  POWER: [0, 50_000_000],
  DOOR: [0, 1],
  HEARTBEAT: [0, 0],
});

const TEMP_WIRE: Record<TemperatureUnit, WireUnit> = { CELSIUS: 'mC', FAHRENHEIT: 'mF', KELVIN: 'mK' };
const OTHER_WIRE: Record<Exclude<ChannelKind, 'TEMPERATURE'>, WireUnit> = {
  CURRENT: 'mA',
  POWER: 'mW',
  DOOR: 'bool',
  HEARTBEAT: 'none',
};

export const wireUnitFor = (rev: Pick<ChannelRevisionView, 'kind' | 'sourceUnit'>): WireUnit | null =>
  rev.kind === 'TEMPERATURE' ? (rev.sourceUnit ? TEMP_WIRE[rev.sourceUnit] : null) : OTHER_WIRE[rev.kind];

export type Normalized =
  | {
      ok: true;
      rawValueInt: number;
      valueInt: number;
      conversion: 'EXACT' | 'ROUNDED_HALF_EVEN';
      flags: QualityFlag[];
    }
  | { ok: false; reasonCode: 'UNIT_MISMATCH' | 'VALUE_OUT_OF_CONTRACT' };

export function normalizeSample(wireUnit: WireUnit, valueInt: number, rev: ChannelRevisionView): Normalized {
  if (wireUnitFor(rev) !== wireUnit) return { ok: false, reasonCode: 'UNIT_MISMATCH' };
  let raw: number;
  let conversion: 'EXACT' | 'ROUNDED_HALF_EVEN' = 'EXACT';
  if (rev.kind === 'TEMPERATURE') {
    try {
      const r = temperatureFromSource(formatScaled(BigInt(valueInt), 3), rev.sourceUnit!);
      raw = r.milliCelsius;
      conversion = r.conversion;
    } catch {
      return { ok: false, reasonCode: 'VALUE_OUT_OF_CONTRACT' };
    }
  } else {
    raw = valueInt;
    if (rev.kind === 'DOOR' && raw !== 0 && raw !== 1) return { ok: false, reasonCode: 'VALUE_OUT_OF_CONTRACT' };
    if (rev.kind === 'HEARTBEAT' && raw !== 0) return { ok: false, reasonCode: 'VALUE_OUT_OF_CONTRACT' };
  }
  const value = rev.kind === 'TEMPERATURE' ? raw + rev.calibrationOffsetMilli : raw;
  if (!Number.isSafeInteger(value)) return { ok: false, reasonCode: 'VALUE_OUT_OF_CONTRACT' };
  const [lo, hi] = PLAUSIBLE_RANGE[rev.kind];
  const flags: QualityFlag[] = value < lo || value > hi ? ['OUT_OF_RANGE'] : [];
  return { ok: true, rawValueInt: raw, valueInt: value, conversion, flags };
}
