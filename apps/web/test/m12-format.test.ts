// Unambiguous money, time and unit formatting (UI-SPEC §13): money from integer minor units with the ISO 4217 exponent
// (never floats), UTC timestamps that say UTC, milli-degrees rendered with one decimal and the unit.
import { describe, expect, it } from 'vitest';
import { formatMilliCelsius, formatMinor, formatUtc } from '../src/format.js';

describe('M12 formatting', () => {
  it('formats minor units exactly with the currency exponent', () => {
    expect(formatMinor('18500', 'USD')).toBe('185.00 USD');
    expect(formatMinor('5', 'USD')).toBe('0.05 USD');
    expect(formatMinor('-1250', 'EUR')).toBe('-12.50 EUR');
    expect(formatMinor('1000', 'JPY')).toBe('1000 JPY');
    expect(formatMinor('9223372036854775807', 'USD')).toBe('92233720368547758.07 USD');
    expect(formatMinor('1234', 'BHD')).toBe('1.234 BHD');
  });

  it('formats UTC instants explicitly and missing values honestly', () => {
    expect(formatUtc('2026-11-05T14:03:09.123Z')).toBe('2026-11-05 14:03:09 UTC');
    expect(formatUtc(null)).toBe('Not reported');
  });

  it('formats milli-degrees Celsius with the unit', () => {
    expect(formatMilliCelsius(4_000)).toBe('4.0 °C');
    expect(formatMilliCelsius(-1_250)).toBe('-1.3 °C');
    expect(formatMilliCelsius(9_449)).toBe('9.4 °C');
  });
});
