// Wire schemas of the documented structured provider API sandbox contract (uptimebuyer-provider-api.v1). Provider
// payloads are untrusted: unknown fields are stripped (providers evolve), every field we keep is bounded and typed,
// money is integer minor units in a canonical decimal string plus an ISO currency, and nothing here is ever an
// instruction. These are the shapes T-029 exercises against synthetic live-shaped fixtures; a real probe is NOT_RUN.
import { CurrencyCodeSchema, UtcInstantSchema } from '@uptimebuyer/contracts';
import { z } from 'zod';

const minorUnits = z
  .union([z.string().regex(/^(0|[1-9]\d{0,17})$/), z.int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => BigInt(v));
const text = (max: number) => z.string().min(1).max(max);
const ref = z.string().regex(/^[\x21-\x7E]{1,128}$/);

export const AVAILABILITY_STATUSES = Object.freeze(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN'] as const);
export const AvailabilityStatusSchema = z.enum(AVAILABILITY_STATUSES);
export const PROVIDER_KINDS = Object.freeze([
  'TECHNICIAN',
  'SUPPLIER',
  'DIAGNOSTIC_SERVICE',
  'CONTAINMENT_SUPPLIER',
  'CATALOG',
] as const);
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export const PRICE_BASES = Object.freeze(['CALLOUT', 'HOURLY', 'FIXED', 'ESTIMATE'] as const);

export const WirePriceSchema = z.object({
  amountMinor: minorUnits,
  currency: CurrencyCodeSchema,
  basis: z.enum(PRICE_BASES),
});

export const WireCandidateSchema = z.object({
  id: ref,
  name: text(200),
  kind: ProviderKindSchema,
  country: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().max(16).nullable().optional(),
  website: z.string().max(253).nullable().optional(),
  serviceArea: z
    .object({
      countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50),
      postalPrefixes: z.array(z.string().max(16)).max(200),
    })
    .optional(),
  contacts: z
    .array(z.object({ channel: z.enum(['PHONE', 'EMAIL', 'API']), value: z.string().min(1).max(320) }))
    .max(5)
    .default([]),
  availability: z.object({ status: AvailabilityStatusSchema, nextWindowAt: UtcInstantSchema.nullable() }),
  price: WirePriceSchema.nullable(),
  etaMinutes: z.int().min(0).max(100_000).nullable(),
  capabilities: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .max(32)
    .default([]),
});
export type WireCandidate = z.output<typeof WireCandidateSchema>;

export const ProviderSearchPageSchema = z.object({
  schema: z.literal('provider-search-page.v1'),
  items: z.array(WireCandidateSchema).max(50),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,512}$/)
    .nullable(),
});
export type ProviderSearchPage = z.output<typeof ProviderSearchPageSchema>;

export const WireQuoteSchema = z.object({
  scope: z.enum(['DIAGNOSTIC_VISIT', 'REPAIR_LABOR', 'PART_SUPPLY', 'CONTAINMENT']),
  amountMinor: minorUnits.nullable(),
  taxMinor: minorUnits.nullable(),
  currency: CurrencyCodeSchema.nullable(),
  etaMinutes: z.int().min(0).max(100_000).nullable(),
  validUntil: UtcInstantSchema.nullable(),
  availability: AvailabilityStatusSchema,
});
export type WireQuote = z.output<typeof WireQuoteSchema>;

export const WireConsentSchema = z.object({
  recording: z.enum(['GRANTED', 'DECLINED', 'NOT_APPLICABLE']),
  processing: z.enum(['GRANTED', 'DECLINED']),
});

/** Raw provider status words are retained verbatim (bounded) next to the normalized outcome (INV-12). */
export const CONTACT_RAW_STATUSES = Object.freeze(['received', 'quoted', 'declined', 'cancelled'] as const);

export const ContactAckSchema = z.object({
  schema: z.literal('contact-ack.v1'),
  status: z.enum(CONTACT_RAW_STATUSES),
  requestRef: ref.nullable(),
  reason: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  consent: WireConsentSchema.optional(),
  quote: WireQuoteSchema.nullable().optional(),
});
export type ContactAck = z.output<typeof ContactAckSchema>;

export const ContactStatusSchema = z.object({
  schema: z.literal('contact-status.v1'),
  status: z.enum(CONTACT_RAW_STATUSES),
  requestRef: ref.nullable(),
  quote: WireQuoteSchema.nullable().optional(),
});

export const ProviderErrorBodySchema = z.object({
  error: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('RATE_LIMITED'), retryAfterMs: z.int().min(0).max(86_400_000) }),
    z.object({
      kind: z.literal('PROVIDER_ERROR'),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      retryable: z.boolean(),
    }),
    z.object({ kind: z.literal('NOT_FOUND') }),
    z.object({ kind: z.literal('LOOKUP_UNSUPPORTED') }),
    z.object({ kind: z.literal('INVALID_REQUEST') }),
  ]),
});
