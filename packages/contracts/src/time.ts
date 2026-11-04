// UTC instants (canonical ISO-8601 with milliseconds and `Z`), integer-millisecond durations, IANA zones.
import { z } from 'zod';
import { DomainError } from './errors.js';

const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const UtcInstantSchema = z
  .string()
  .regex(UTC_INSTANT_RE)
  .refine((s) => {
    const t = Date.parse(s);
    return Number.isFinite(t) && new Date(t).toISOString() === s;
  }, 'Not a real UTC calendar instant.')
  .brand<'UtcInstant'>();
export type UtcInstant = z.infer<typeof UtcInstantSchema>;

export const DurationMsSchema = z.int().min(0).brand<'DurationMs'>();
export type DurationMs = z.infer<typeof DurationMsSchema>;

/** IANA timezone name, preserved for presentation/SOP basis only; storage is always UTC. */
export const IanaTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA timezone.');

export function instantFromEpochMs(ms: number): UtcInstant {
  if (!Number.isSafeInteger(ms)) throw new DomainError('VALIDATION_FAILED', 'Expected integer epoch milliseconds.');
  const iso = new Date(ms).toISOString();
  const r = UtcInstantSchema.safeParse(iso);
  if (!r.success) throw new DomainError('VALIDATION_FAILED', 'Epoch milliseconds out of range.');
  return r.data;
}

export const epochMsOf = (instant: UtcInstant): number => Date.parse(instant);

export function durationMs(ms: number): DurationMs {
  const r = DurationMsSchema.safeParse(ms);
  if (!r.success) throw new DomainError('VALIDATION_FAILED', 'Expected non-negative integer milliseconds.');
  return r.data;
}

/** end - start; a negative span is rejected rather than clamped. */
export function durationBetween(start: UtcInstant, end: UtcInstant): DurationMs {
  const d = epochMsOf(end) - epochMsOf(start);
  if (d < 0) throw new DomainError('VALIDATION_FAILED', 'End precedes start.');
  return durationMs(d);
}

export const addDuration = (instant: UtcInstant, d: DurationMs): UtcInstant =>
  instantFromEpochMs(epochMsOf(instant) + d);
