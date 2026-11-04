// Exact decimal/rational helpers (bigint). No binary floating point anywhere on money, measurement or scoring paths.
import { DomainError } from './errors.js';

export type Rational = { readonly num: bigint; readonly den: bigint };

const DECIMAL_RE = /^-?(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$/;

export const isCanonicalDecimal = (text: unknown): text is string =>
  typeof text === 'string' && DECIMAL_RE.test(text) && !/^-0(\.0+)?$/.test(text);

/** Parse a canonical decimal string (no exponent, no grouping, no leading zeros, no negative zero) exactly. */
export function parseDecimal(text: unknown): Rational {
  if (!isCanonicalDecimal(text)) throw new DomainError('VALIDATION_FAILED', 'Expected a canonical decimal string.');
  const negative = text.startsWith('-');
  const [int, frac = ''] = (negative ? text.slice(1) : text).split('.') as [string, string?];
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(int + frac) * (negative ? -1n : 1n);
  return { num, den };
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Round num/den to an integer, ties to even. */
export function roundHalfEven(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new DomainError('VALIDATION_FAILED', 'Division by zero.');
  if (den < 0n) return roundHalfEven(-num, -den);
  const q = num / den; // truncates toward zero
  const r = num - q * den;
  const twice = 2n * abs(r);
  const away = num < 0n ? q - 1n : q + 1n;
  if (twice > den) return away;
  if (twice < den) return q;
  return q % 2n === 0n ? q : away;
}

/** Round num/den to an integer, ties away from zero ("half-up" on magnitudes). */
export function roundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new DomainError('VALIDATION_FAILED', 'Division by zero.');
  if (den < 0n) return roundHalfUp(-num, -den);
  const q = num / den;
  const r = num - q * den;
  if (2n * abs(r) >= den && r !== 0n) return num < 0n ? q - 1n : q + 1n;
  return q;
}

/** Format an integer count of 10^-scale units as a decimal string. */
export function formatScaled(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = abs(value).toString();
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}
