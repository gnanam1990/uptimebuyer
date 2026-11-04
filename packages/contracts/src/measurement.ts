// Measurements: integer canonical units with the source value and unit retained. Temperature is integer
// milli-degrees Celsius; conversion is exact rational arithmetic with one labelled half-even rounding.
import { z } from 'zod';
import { DomainError } from './errors.js';
import { formatScaled, isCanonicalDecimal, parseDecimal, roundHalfEven } from './rational.js';

export const DecimalStringSchema = z
  .string()
  .refine(isCanonicalDecimal, { message: 'Expected a canonical decimal string.' });

export const TEMPERATURE_UNITS = Object.freeze(['CELSIUS', 'FAHRENHEIT', 'KELVIN'] as const);
export const TemperatureUnitSchema = z.enum(TEMPERATURE_UNITS);
export type TemperatureUnit = z.infer<typeof TemperatureUnitSchema>;

export const TEMPERATURE_CONVERSIONS = Object.freeze(['EXACT', 'ROUNDED_HALF_EVEN'] as const);
export type TemperatureConversion = (typeof TEMPERATURE_CONVERSIONS)[number];

export const ABSOLUTE_ZERO_MILLI_CELSIUS = -273_150;
/** Generous physical upper bound (10 000 °C) that keeps every value a safe integer. */
export const MAX_MILLI_CELSIUS = 10_000_000;

/** Exact rational value of the source reading in milli-degrees Celsius. */
function toMilliCelsiusRational(value: string, unit: TemperatureUnit): { num: bigint; den: bigint } {
  const { num, den } = parseDecimal(value);
  switch (unit) {
    case 'CELSIUS':
      return { num: num * 1000n, den };
    case 'FAHRENHEIT':
      return { num: (num - 32n * den) * 5000n, den: 9n * den };
    case 'KELVIN':
      return { num: num * 1000n - 273_150n * den, den };
    default:
      throw new DomainError('VALIDATION_FAILED', 'Unknown temperature unit.');
  }
}

function convert(value: unknown, unit: unknown): { milliCelsius: number; conversion: TemperatureConversion } {
  if (!TemperatureUnitSchema.safeParse(unit).success)
    throw new DomainError('VALIDATION_FAILED', 'Unknown temperature unit.');
  if (!isCanonicalDecimal(value)) throw new DomainError('VALIDATION_FAILED', 'Expected a canonical decimal string.');
  const { num, den } = toMilliCelsiusRational(value, unit as TemperatureUnit);
  // Absolute zero is checked on the exact value, before rounding.
  if (num < BigInt(ABSOLUTE_ZERO_MILLI_CELSIUS) * den)
    throw new DomainError('VALIDATION_FAILED', 'Temperature is below absolute zero.');
  const rounded = roundHalfEven(num, den);
  if (rounded > BigInt(MAX_MILLI_CELSIUS)) throw new DomainError('VALIDATION_FAILED', 'Temperature is out of range.');
  return { milliCelsius: Number(rounded), conversion: num % den === 0n ? 'EXACT' : 'ROUNDED_HALF_EVEN' };
}

export const TemperatureReadingSchema = z
  .strictObject({
    milliCelsius: z.int().min(ABSOLUTE_ZERO_MILLI_CELSIUS).max(MAX_MILLI_CELSIUS),
    source: z.strictObject({ unit: TemperatureUnitSchema, value: DecimalStringSchema }),
    conversion: z.enum(TEMPERATURE_CONVERSIONS),
  })
  .superRefine((r, ctx) => {
    let expected: ReturnType<typeof convert>;
    try {
      expected = convert(r.source.value, r.source.unit);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'Source reading cannot be converted.' });
      return;
    }
    if (expected.milliCelsius !== r.milliCelsius)
      ctx.addIssue({
        code: 'custom',
        path: ['milliCelsius'],
        message: 'Canonical value does not match the source reading.',
      });
    if (expected.conversion !== r.conversion)
      ctx.addIssue({
        code: 'custom',
        path: ['conversion'],
        message: 'Conversion label does not match the source reading.',
      });
  });
export type TemperatureReading = z.output<typeof TemperatureReadingSchema>;

/** Normalize a source reading to canonical milli-°C, retaining the exact source value and unit. */
export function temperatureFromSource(value: string, unit: TemperatureUnit): TemperatureReading {
  const { milliCelsius, conversion } = convert(value, unit);
  return { milliCelsius, source: { unit, value }, conversion };
}

/** Render canonical milli-°C in a display unit, exactly then rounded half-even to `fractionDigits`. */
export function milliCelsiusToUnit(milliCelsius: number, unit: TemperatureUnit, fractionDigits: number): string {
  if (!Number.isSafeInteger(milliCelsius))
    throw new DomainError('VALIDATION_FAILED', 'Expected integer milli-degrees.');
  if (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 9)
    throw new DomainError('VALIDATION_FAILED', 'Expected 0..9 fraction digits.');
  const m = BigInt(milliCelsius);
  const r =
    unit === 'CELSIUS'
      ? { num: m, den: 1000n }
      : unit === 'KELVIN'
        ? { num: m + 273_150n, den: 1000n }
        : unit === 'FAHRENHEIT'
          ? { num: m * 9n + 160_000n, den: 5000n }
          : null;
  if (!r) throw new DomainError('VALIDATION_FAILED', 'Unknown temperature unit.');
  const scale = 10n ** BigInt(fractionDigits);
  return formatScaled(roundHalfEven(r.num * scale, r.den), fractionDigits);
}

/** Canonical measurement union. Current and power are integer milli-units. */
export const MeasurementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('TEMPERATURE'), temperature: TemperatureReadingSchema }),
  z.strictObject({ kind: z.literal('CURRENT'), milliAmperes: z.int().min(0) }),
  z.strictObject({ kind: z.literal('POWER'), milliWatts: z.int().min(0) }),
]);
export type Measurement = z.output<typeof MeasurementSchema>;
