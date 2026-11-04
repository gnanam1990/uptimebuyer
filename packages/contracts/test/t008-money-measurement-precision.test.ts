// T-008 — Money and measurement precision: currency minor units, temperature units, timestamps, durations and
// probabilities preserve declared precision; float drift and unit confusion are rejected.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DomainError,
  DurationMsSchema,
  INT64_MAX,
  MoneySchema,
  PpmSchema,
  TemperatureReadingSchema,
  UtcInstantSchema,
  addMoney,
  applyPpm,
  compareMoney,
  decodeWire,
  durationBetween,
  epochMsOf,
  formatMoneyDecimal,
  instantFromEpochMs,
  milliCelsiusToUnit,
  money,
  mulDivRoundHalfUp,
  parseMoneyDecimal,
  ppm,
  ppmFromDecimal,
  subtractMoney,
  sumMoney,
  temperatureFromSource,
} from '../src/index.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain:${String(e)}`;
  }
  return undefined;
};

describe('T-008 money precision', () => {
  it('stores money as bigint minor units with an ISO 4217 currency', () => {
    const m = money(48200n, 'USD');
    expect(m).toEqual({ amountMinor: 48200n, currency: 'USD' });
    expect(typeof m.amountMinor).toBe('bigint');
  });

  it('rejects binary floating point and unsafe numbers at every entry point', () => {
    expect(codeOf(() => money(0.1 as unknown as bigint, 'USD'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => money(10 as unknown as bigint, 'USD'))).toBe('VALIDATION_FAILED');
    expect(z.safeDecode(MoneySchema, { amountMinor: 0.1, currency: 'USD' }).success).toBe(false);
    expect(z.safeDecode(MoneySchema, { amountMinor: 2 ** 53, currency: 'USD' }).success).toBe(false);
    expect(z.safeDecode(MoneySchema, { amountMinor: '1e3', currency: 'USD' }).success).toBe(false);
    expect(z.safeDecode(MoneySchema, { amountMinor: '010', currency: 'USD' }).success).toBe(false);
    expect(z.safeDecode(MoneySchema, { amountMinor: '-1', currency: 'USD' }).success).toBe(false);
    expect(z.safeDecode(MoneySchema, { amountMinor: '12.5', currency: 'USD' }).success).toBe(false);
    // A safe integer number and a canonical decimal string are accepted and become the same bigint.
    expect(decodeWire(MoneySchema, { amountMinor: 48200, currency: 'USD' })).toEqual(money(48200n, 'USD'));
    expect(decodeWire(MoneySchema, { amountMinor: '48200', currency: 'USD' })).toEqual(money(48200n, 'USD'));
  });

  it('has no float drift: 0.1 + 0.2 is exactly 0.3 in minor units', () => {
    const a = parseMoneyDecimal('0.10', 'USD');
    const b = parseMoneyDecimal('0.20', 'USD');
    expect(addMoney(a, b)).toEqual(parseMoneyDecimal('0.30', 'USD'));
    let total = money(0n, 'USD');
    for (let i = 0; i < 1000; i++) total = addMoney(total, parseMoneyDecimal('0.01', 'USD'));
    expect(formatMoneyDecimal(total)).toBe('10.00');
  });

  it('respects each currency exponent and rejects precision the currency cannot hold', () => {
    expect(parseMoneyDecimal('482', 'JPY')).toEqual(money(482n, 'JPY'));
    expect(codeOf(() => parseMoneyDecimal('482.5', 'JPY'))).toBe('PRECISION_LOSS');
    expect(parseMoneyDecimal('1.234', 'KWD')).toEqual(money(1234n, 'KWD'));
    expect(codeOf(() => parseMoneyDecimal('1.001', 'USD'))).toBe('PRECISION_LOSS');
    expect(parseMoneyDecimal('1.5', 'USD')).toEqual(money(150n, 'USD'));
    expect(formatMoneyDecimal(money(5n, 'USD'))).toBe('0.05');
    expect(formatMoneyDecimal(money(1234n, 'KWD'))).toBe('1.234');
    expect(formatMoneyDecimal(money(7n, 'JPY'))).toBe('7');
    expect(codeOf(() => parseMoneyDecimal('1,00', 'USD'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => money(1n, 'XYZ' as 'USD'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => money(1n, 'usd' as 'USD'))).toBe('VALIDATION_FAILED');
  });

  it('rejects currency confusion in arithmetic and comparison', () => {
    expect(codeOf(() => addMoney(money(1n, 'USD'), money(1n, 'EUR')))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => subtractMoney(money(5n, 'USD'), money(1n, 'GBP')))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => compareMoney(money(1n, 'USD'), money(1n, 'JPY')))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => sumMoney([money(1n, 'USD'), money(1n, 'EUR')]))).toBe('CURRENCY_MISMATCH');
    expect(compareMoney(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
  });

  it('is overflow-safe against the signed 64-bit persistence bound', () => {
    expect(decodeWire(MoneySchema, { amountMinor: INT64_MAX.toString(), currency: 'USD' }).amountMinor).toBe(INT64_MAX);
    expect(z.safeDecode(MoneySchema, { amountMinor: (INT64_MAX + 1n).toString(), currency: 'USD' }).success).toBe(
      false,
    );
    expect(codeOf(() => addMoney(money(INT64_MAX, 'USD'), money(1n, 'USD')))).toBe('MONEY_OUT_OF_RANGE');
    expect(codeOf(() => subtractMoney(money(1n, 'USD'), money(2n, 'USD')))).toBe('MONEY_OUT_OF_RANGE');
    // Values above 2^53 survive exactly (a float would round them).
    const big = money(9007199254740993n, 'USD');
    expect(addMoney(big, money(0n, 'USD')).amountMinor).toBe(9007199254740993n);
  });

  it('computes rational intermediates exactly and rounds half-up once', () => {
    // 1 ms of delay at 100.00/hour is 0.0000277… minor units: must not truncate to zero before summing.
    expect(mulDivRoundHalfUp(1_800_000n, 10_000n, 3_600_000n)).toBe(5_000n);
    expect(mulDivRoundHalfUp(1n, 1n, 2n)).toBe(1n);
    expect(mulDivRoundHalfUp(1n, 1n, 3n)).toBe(0n);
    expect(codeOf(() => mulDivRoundHalfUp(1n, 1n, 0n))).toBe('VALIDATION_FAILED');
    expect(applyPpm(money(1_000_000n, 'USD'), ppm(12_500))).toEqual(money(12_500n, 'USD'));
    expect(applyPpm(money(3n, 'USD'), ppm(500_000))).toEqual(money(2n, 'USD'));
  });
});

describe('T-008 temperature precision and unit safety', () => {
  it('stores integer milli-degrees Celsius and retains the exact source value and unit', () => {
    const r = temperatureFromSource('4.125', 'CELSIUS');
    expect(r).toEqual({ milliCelsius: 4125, source: { unit: 'CELSIUS', value: '4.125' }, conversion: 'EXACT' });
  });

  it('converts Fahrenheit and Kelvin exactly where representable', () => {
    expect(temperatureFromSource('32', 'FAHRENHEIT').milliCelsius).toBe(0);
    expect(temperatureFromSource('41', 'FAHRENHEIT')).toMatchObject({ milliCelsius: 5000, conversion: 'EXACT' });
    expect(temperatureFromSource('-40', 'FAHRENHEIT').milliCelsius).toBe(-40000);
    expect(temperatureFromSource('273.15', 'KELVIN')).toMatchObject({ milliCelsius: 0, conversion: 'EXACT' });
    expect(temperatureFromSource('277.275', 'KELVIN').milliCelsius).toBe(4125);
  });

  it('rounds a non-representable conversion once, half-even, and labels it', () => {
    // 38.4 °F = 3.5555… °C -> 3556 m°C; 33.8 °F = 1 °C exactly.
    expect(temperatureFromSource('38.4', 'FAHRENHEIT')).toEqual({
      milliCelsius: 3556,
      source: { unit: 'FAHRENHEIT', value: '38.4' },
      conversion: 'ROUNDED_HALF_EVEN',
    });
    expect(temperatureFromSource('33.8', 'FAHRENHEIT')).toMatchObject({ milliCelsius: 1000, conversion: 'EXACT' });
    expect(temperatureFromSource('0.0005', 'CELSIUS').milliCelsius).toBe(0);
    expect(temperatureFromSource('0.0015', 'CELSIUS').milliCelsius).toBe(2);
  });

  it('rejects unit confusion: canonical value must equal the conversion of the retained source', () => {
    const confused = { milliCelsius: 38400, source: { unit: 'FAHRENHEIT', value: '38.4' }, conversion: 'EXACT' };
    expect(TemperatureReadingSchema.safeParse(confused).success).toBe(false);
    const mislabelled = { milliCelsius: 3556, source: { unit: 'FAHRENHEIT', value: '38.4' }, conversion: 'EXACT' };
    expect(TemperatureReadingSchema.safeParse(mislabelled).success).toBe(false);
    const ok = { milliCelsius: 3556, source: { unit: 'FAHRENHEIT', value: '38.4' }, conversion: 'ROUNDED_HALF_EVEN' };
    expect(TemperatureReadingSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects floats, unknown units and sub-absolute-zero readings', () => {
    expect(
      TemperatureReadingSchema.safeParse({ ...temperatureFromSource('4', 'CELSIUS'), milliCelsius: 4000.5 }).success,
    ).toBe(false);
    expect(codeOf(() => temperatureFromSource('4', 'RANKINE' as 'CELSIUS'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => temperatureFromSource('4.0e1', 'CELSIUS'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => temperatureFromSource(4 as unknown as string, 'CELSIUS'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => temperatureFromSource('-274', 'CELSIUS'))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => temperatureFromSource('-1', 'KELVIN'))).toBe('VALIDATION_FAILED');
  });

  it('converts canonical milli-Celsius back to a display unit without float drift', () => {
    expect(milliCelsiusToUnit(5000, 'FAHRENHEIT', 1)).toBe('41.0');
    expect(milliCelsiusToUnit(3556, 'FAHRENHEIT', 2)).toBe('38.40');
    expect(milliCelsiusToUnit(4125, 'CELSIUS', 3)).toBe('4.125');
    expect(milliCelsiusToUnit(0, 'KELVIN', 2)).toBe('273.15');
    expect(milliCelsiusToUnit(-40000, 'FAHRENHEIT', 0)).toBe('-40');
  });
});

describe('T-008 timestamps, durations and probabilities', () => {
  it('accepts only canonical UTC instants with millisecond precision', () => {
    expect(UtcInstantSchema.safeParse('2026-11-04T10:00:00.000Z').success).toBe(true);
    for (const bad of [
      '2026-11-04T10:00:00Z',
      '2026-11-04T10:00:00.000+01:00',
      '2026-11-04T10:00:00.0001Z',
      '2026-02-30T10:00:00.000Z',
      '2026-11-04 10:00:00.000Z',
      1730714400000,
    ])
      expect(UtcInstantSchema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('round-trips epoch milliseconds exactly and rejects fractional or unsafe values', () => {
    const i = instantFromEpochMs(1_793_784_000_123);
    expect(i).toBe('2026-11-04T09:20:00.123Z');
    expect(epochMsOf(i)).toBe(1_793_784_000_123);
    expect(codeOf(() => instantFromEpochMs(1.5))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => instantFromEpochMs(Number.MAX_SAFE_INTEGER + 1))).toBe('VALIDATION_FAILED');
  });

  it('represents durations as non-negative integer milliseconds', () => {
    expect(DurationMsSchema.safeParse(900_000).success).toBe(true);
    expect(DurationMsSchema.safeParse(1.5).success).toBe(false);
    expect(DurationMsSchema.safeParse(-1).success).toBe(false);
    expect(DurationMsSchema.safeParse('900000').success).toBe(false);
    const a = instantFromEpochMs(1_000);
    const b = instantFromEpochMs(61_000);
    expect(durationBetween(a, b)).toBe(60_000);
    expect(codeOf(() => durationBetween(b, a))).toBe('VALIDATION_FAILED');
  });

  it('represents probabilities as integer parts-per-million with exact decimal conversion', () => {
    expect(ppmFromDecimal('0.0125')).toBe(12_500);
    expect(ppmFromDecimal('1')).toBe(1_000_000);
    expect(ppmFromDecimal('0.000001')).toBe(1);
    expect(codeOf(() => ppmFromDecimal('0.0000001'))).toBe('PRECISION_LOSS');
    expect(codeOf(() => ppmFromDecimal('1.000001'))).toBe('VALIDATION_FAILED');
    expect(PpmSchema.safeParse(0.5).success).toBe(false);
    expect(PpmSchema.safeParse(1_000_001).success).toBe(false);
    expect(codeOf(() => ppm(0.25))).toBe('VALIDATION_FAILED');
  });
});
