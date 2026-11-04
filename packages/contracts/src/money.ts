// Money: integer minor units (bigint) + ISO 4217 currency. Never binary floating point.
import { z } from 'zod';
import { DomainError } from './errors.js';
import { formatScaled, parseDecimal, roundHalfUp } from './rational.js';
import { encodeWire } from './wire.js';

/** ISO 4217 codes this product accepts, with their minor-unit exponent. Unknown codes are rejected, not guessed. */
export const ISO_4217_MINOR_UNITS = Object.freeze({
  AED: 2,
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PLN: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  TND: 3,
  TRY: 2,
  USD: 2,
  VND: 0,
  ZAR: 2,
} as const);
export type CurrencyCode = keyof typeof ISO_4217_MINOR_UNITS;
export const CurrencyCodeSchema = z.enum(Object.keys(ISO_4217_MINOR_UNITS) as [CurrencyCode, ...CurrencyCode[]]);

/** Persistence bound: PostgreSQL `bigint` (signed 64-bit). */
export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

const CANONICAL_UINT = /^(0|[1-9][0-9]{0,18})$/;
const CANONICAL_INT = /^(0|-?[1-9][0-9]{0,18})$/;

/** Non-negative minor units. Wire: canonical decimal string (or safe integer number); domain: bigint. */
export const MinorUnitsSchema = z.codec(
  z.union([z.string().regex(CANONICAL_UINT), z.int().min(0)]),
  z.bigint().min(0n).max(INT64_MAX),
  { decode: (v) => BigInt(v), encode: (b) => b.toString() },
);
const SignedMinorUnitsSchema = z.codec(
  z.union([z.string().regex(CANONICAL_INT), z.int()]),
  z.bigint().min(INT64_MIN).max(INT64_MAX),
  { decode: (v) => BigInt(v), encode: (b) => b.toString() },
);

export const MoneySchema = z.strictObject({ amountMinor: MinorUnitsSchema, currency: CurrencyCodeSchema });
export type Money = z.output<typeof MoneySchema>;
export type MoneyWire = z.input<typeof MoneySchema>;

/** A signed amount (ledger deltas, adjustments). Same precision and range rules. */
export const SignedMoneySchema = z.strictObject({ amountMinor: SignedMinorUnitsSchema, currency: CurrencyCodeSchema });
export type SignedMoney = z.output<typeof SignedMoneySchema>;

export const minorUnitExponent = (currency: CurrencyCode): number => {
  const e = (ISO_4217_MINOR_UNITS as Record<string, number>)[currency];
  if (e === undefined) throw new DomainError('VALIDATION_FAILED', 'Unknown ISO 4217 currency.');
  return e;
};

function checkRange(v: bigint): bigint {
  if (v < 0n || v > INT64_MAX)
    throw new DomainError('MONEY_OUT_OF_RANGE', 'Money result is outside the representable range.');
  return v;
}

/** Construct validated money. Rejects number amounts (floats or not), unknown currencies and out-of-range values. */
export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return Object.freeze({ ...encodeAndBack({ amountMinor, currency }) });
}

function encodeAndBack(value: Money): Money {
  encodeWire(MoneySchema, value);
  return { amountMinor: value.amountMinor, currency: value.currency };
}

/** Parse a human decimal amount ("482.00") exactly for the currency exponent; excess non-zero precision is rejected. */
export function parseMoneyDecimal(text: string, currency: CurrencyCode): Money {
  if (typeof text !== 'string' || text.startsWith('-'))
    throw new DomainError('VALIDATION_FAILED', 'Expected a non-negative decimal string.');
  const exponent = minorUnitExponent(currency);
  const { num, den } = parseDecimal(text);
  const scaled = num * 10n ** BigInt(exponent);
  if (scaled % den !== 0n)
    throw new DomainError('PRECISION_LOSS', 'Amount has more precision than the currency allows.');
  return money(checkRange(scaled / den), currency);
}

export const formatMoneyDecimal = (m: Money): string => formatScaled(m.amountMinor, minorUnitExponent(m.currency));

export function assertSameCurrency(a: { currency: CurrencyCode }, b: { currency: CurrencyCode }): void {
  if (a.currency !== b.currency)
    throw new DomainError(
      'CURRENCY_MISMATCH',
      'Cross-currency arithmetic is forbidden without an explicit rate policy.',
    );
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(checkRange(a.amountMinor + b.amountMinor), a.currency);
}

/** a - b; a negative result is out of range for (non-negative) money. */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(checkRange(a.amountMinor - b.amountMinor), a.currency);
}

export function sumMoney(items: readonly Money[]): Money {
  const [first, ...rest] = items;
  if (!first) throw new DomainError('VALIDATION_FAILED', 'Cannot sum an empty list without a currency.');
  return rest.reduce(addMoney, money(first.amountMinor, first.currency));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/** Exact a * b / c with a single half-up rounding (ties away from zero). */
export function mulDivRoundHalfUp(a: bigint, b: bigint, c: bigint): bigint {
  if (typeof a !== 'bigint' || typeof b !== 'bigint' || typeof c !== 'bigint')
    throw new DomainError('VALIDATION_FAILED', 'Exact arithmetic requires bigint operands.');
  if (c === 0n) throw new DomainError('VALIDATION_FAILED', 'Division by zero.');
  return roundHalfUp(a * b, c);
}

/** Apply a parts-per-million factor to money, rounding half-up once. */
export function applyPpm(m: Money, partsPerMillion: number): Money {
  if (!Number.isSafeInteger(partsPerMillion) || partsPerMillion < 0)
    throw new DomainError('VALIDATION_FAILED', 'Expected integer parts per million.');
  return money(checkRange(mulDivRoundHalfUp(m.amountMinor, BigInt(partsPerMillion), 1_000_000n)), m.currency);
}
