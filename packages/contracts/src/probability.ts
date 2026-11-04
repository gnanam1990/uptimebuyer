// Probabilities as integer parts-per-million.
import { z } from 'zod';
import { DomainError } from './errors.js';
import { isCanonicalDecimal, parseDecimal } from './rational.js';

export const PPM_SCALE = 1_000_000;
export const PpmSchema = z.int().min(0).max(PPM_SCALE).brand<'Ppm'>();
export type Ppm = z.infer<typeof PpmSchema>;

export function ppm(value: number): Ppm {
  const r = PpmSchema.safeParse(value);
  if (!r.success) throw new DomainError('VALIDATION_FAILED', 'Expected integer parts per million in 0..1000000.');
  return r.data;
}

/** Exact conversion of a decimal probability ("0.0125") to ppm; precision finer than 1 ppm is rejected. */
export function ppmFromDecimal(text: string): Ppm {
  if (!isCanonicalDecimal(text) || text.startsWith('-'))
    throw new DomainError('VALIDATION_FAILED', 'Expected a non-negative decimal probability.');
  const { num, den } = parseDecimal(text);
  const scaled = num * BigInt(PPM_SCALE);
  if (scaled % den !== 0n) throw new DomainError('PRECISION_LOSS', 'Probability is finer than one part per million.');
  const v = scaled / den;
  if (v > BigInt(PPM_SCALE)) throw new DomainError('VALIDATION_FAILED', 'Probability exceeds one.');
  return ppm(Number(v));
}
