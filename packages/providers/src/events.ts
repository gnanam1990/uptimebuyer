// Typed M07 event payloads (API-EVENT-SPEC §6). Payloads carry ids, digests and the separate state axes only:
// never contact values, transcript text, credential references or provider free text. Money is a decimal string of
// minor units plus currency.
import { appendOutboxEvent, type Tx, type TenantContext } from '@uptimebuyer/data';
import { defineDomainEvent, newId, type EventType } from '@uptimebuyer/contracts';
import { z } from 'zod';

const id = (p: string) => z.string().regex(new RegExp(`^${p}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$`));
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const digest = z.string().regex(/^([a-z][a-z0-9-]*\.v[1-9][0-9]*:)?sha256:[0-9a-f]{64}$/);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const ProviderSearchCompletedPayloadSchema = z.strictObject({
  searchId: id('psh'),
  incidentId: id('inc'),
  providerAccountRevisionId: id('par'),
  state: z.enum(['COMPLETED', 'TRUNCATED', 'PARTIAL', 'FAILED', 'BLOCKED']),
  stateReason: code.nullable(),
  resultCount: z.int().min(0).max(100),
  pagesFetched: z.int().min(0).max(10),
  adapterClass: z.string().nullable(),
  queryDigest: digest,
});
export const ProviderSearchCompletedEventSchema = defineDomainEvent(
  'provider.search_completed.v1',
  ProviderSearchCompletedPayloadSchema,
  'searchId',
);

export const ProviderContactRequestedPayloadSchema = z.strictObject({
  contactRequestId: id('pcr'),
  incidentId: id('inc'),
  serviceProviderId: id('spr'),
  providerAccountRevisionId: id('par'),
  channel: z.enum(['PHONE', 'EMAIL', 'API']),
  purposeCode: code,
  paid: z.boolean(),
  requestDigest: digest,
  actionDigest: digest.nullable(),
  recordingDisclosure: z.enum(['REQUIRED', 'NOT_APPLICABLE']),
  processingConsent: z.enum(['REQUIRED', 'NOT_REQUIRED']),
});
export const ProviderContactRequestedEventSchema = defineDomainEvent(
  'provider.contact_requested.v1',
  ProviderContactRequestedPayloadSchema,
  'contactRequestId',
);

export const ProviderContactAttemptedPayloadSchema = z.strictObject({
  contactAttemptId: id('pca'),
  contactRequestId: id('pcr'),
  incidentId: id('inc'),
  providerAccountRevisionId: id('par'),
  paid: z.boolean(),
  commercialIntentId: id('cin').nullable(),
  transportState: z.string(),
  externalOutcomeState: z.string(),
  adapterCapability: z.enum(['ELIGIBLE', 'UNSUPPORTED']),
  economicState: z.string().nullable(),
  manualReview: z.boolean(),
  definiteNoEffect: z.boolean(),
  nextReconcileAt: instant.nullable(),
  resultOrigin: z.string(),
  adapterClass: z.string(),
  displayStatus: code,
});
export const ProviderContactAttemptedEventSchema = defineDomainEvent(
  'provider.contact_attempted.v1',
  ProviderContactAttemptedPayloadSchema,
  'contactAttemptId',
);

export const ProviderCommunicationRecordedPayloadSchema = z.strictObject({
  communicationId: id('pcm'),
  contactAttemptId: id('pca'),
  contactRequestId: id('pcr'),
  incidentId: id('inc'),
  commType: z.enum(['EMAIL', 'PHONE_TRANSCRIPT', 'API_MESSAGE']),
  contentDigest: digest,
  excerptDigest: digest.nullable(),
  recordingConsentId: id('pcs').nullable(),
  processingConsentId: id('pcs').nullable(),
  authority: z.literal('NONE'),
});
export const ProviderCommunicationRecordedEventSchema = defineDomainEvent(
  'provider.communication_recorded.v1',
  ProviderCommunicationRecordedPayloadSchema,
  'communicationId',
);

export const ProviderQuoteRecordedPayloadSchema = z.strictObject({
  quoteId: id('pqt'),
  contactRequestId: id('pcr'),
  incidentId: id('inc'),
  serviceProviderId: id('spr'),
  revision: z.int().min(1),
  amountMinor: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  etaMinutes: z.int().min(0).nullable(),
  missingFields: z.array(z.string()).max(8),
  sourceKind: z.enum(['ADAPTER_RESPONSE', 'OPERATOR_ENTRY', 'BROKER_RESULT']),
  authority: z.literal('NONE'),
});
export const ProviderQuoteRecordedEventSchema = defineDomainEvent(
  'provider.quote_recorded.v1',
  ProviderQuoteRecordedPayloadSchema,
  'quoteId',
);

const SCHEMAS = {
  'provider.search_completed.v1': ['provider_search', ProviderSearchCompletedPayloadSchema],
  'provider.contact_requested.v1': ['provider_contact_request', ProviderContactRequestedPayloadSchema],
  'provider.contact_attempted.v1': ['provider_contact_attempt', ProviderContactAttemptedPayloadSchema],
  'provider.communication_recorded.v1': ['provider_communication', ProviderCommunicationRecordedPayloadSchema],
  'provider.quote_recorded.v1': ['provider_quote', ProviderQuoteRecordedPayloadSchema],
} as const;
type ProviderEventType = keyof typeof SCHEMAS;

/** Validate and append an M07 event in the caller's transaction. */
export async function emitProviderEvent(
  c: Tx,
  ctx: TenantContext,
  eventType: ProviderEventType,
  aggregateId: string,
  aggregateVersion: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const [aggregateType, schema] = SCHEMAS[eventType];
  const clean = (schema as z.ZodType).parse(payload) as Record<string, unknown>;
  await appendOutboxEvent(c, ctx, {
    eventType: eventType as EventType,
    aggregateType: aggregateType as never,
    aggregateId,
    aggregateVersion,
    payload: clean,
    correlationId: ctx.correlationId,
    causationId: newId('command'),
  });
}
