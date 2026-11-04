// Contact-attempt projection: row mapping, the canonical display status (never "failed" for an unknown effect and
// never "completed" for a contact), and the single guarded update path. Every projection change appends an
// observation and an outbox event in the same transaction; the database re-checks legal edges (ub_contact_attempt_guard).
import { versionConflict, type TenantContext, type Tx } from '@uptimebuyer/data';
import { emitProviderEvent } from './events.js';
import { appendAttemptEvent, isoOf, type AttemptObservation } from './internal.js';

export interface AttemptRow {
  tenant_id: string;
  id: string;
  contact_request_id: string;
  attempt_number: number;
  provider_account_id: string;
  provider_account_revision_id: string;
  paid: boolean;
  commercial_intent_id: string | null;
  execution_authority_id: string | null;
  approval_id: string | null;
  client_operation_id: string;
  idempotency_key: string;
  request_digest: string;
  transport_state: string;
  external_outcome_state: string;
  adapter_capability: 'ELIGIBLE' | 'UNSUPPORTED';
  capability_reason: string | null;
  economic_state: string | null;
  raw_provider_status: string | null;
  provider_ref: string | null;
  raw_response_digest: string | null;
  next_reconcile_at: Date | null;
  manual_review: boolean;
  definite_no_effect: boolean;
  result_origin: string;
  adapter_class: string;
  last_broker_event_version: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const DISPLAY_STATUSES = Object.freeze([
  'BLOCKED_UNSUPPORTED_CAPABILITY',
  'NOT_SENT_INVALIDATED',
  'NOT_SENT',
  'QUEUED',
  'SENDING',
  'REQUESTED',
  'PROVIDER_ACKNOWLEDGED',
  'PROVIDER_CONFIRMED_CONTACT',
  'OUTCOME_UNKNOWN_RECONCILING',
  'OUTCOME_UNKNOWN_MANUAL_REVIEW',
  'PROVIDER_DECLINED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CANCELLED',
] as const);
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/**
 * The one UI/API label for an attempt, derived from the separate axes (INV-12). An UNKNOWN effect is always shown
 * as unknown (reconciling or manual review), whatever the capability; CONFIRMED is a confirmed contact, never
 * fulfilled work; FAILED appears only with definite no-effect proof.
 */
export function displayStatusOf(a: {
  transportState: string;
  externalOutcomeState: string;
  adapterCapability: string;
  manualReview: boolean;
  definiteNoEffect: boolean;
  rawProviderStatus?: string | null;
}): DisplayStatus {
  if (a.transportState === 'PREPARED') {
    if (a.adapterCapability === 'UNSUPPORTED') return 'BLOCKED_UNSUPPORTED_CAPABILITY';
    if (a.definiteNoEffect) return 'NOT_SENT_INVALIDATED';
    return 'QUEUED';
  }
  switch (a.externalOutcomeState) {
    case 'PROPOSED':
    case 'AUTHORIZED':
      return a.transportState === 'DEFINITE_NO_EFFECT' ? 'NOT_SENT' : 'SENDING';
    case 'REQUESTED':
      return 'REQUESTED';
    case 'ACCEPTED':
      return 'PROVIDER_ACKNOWLEDGED';
    case 'CONFIRMED':
      return 'PROVIDER_CONFIRMED_CONTACT';
    case 'FAILED':
      if (!a.definiteNoEffect) return 'OUTCOME_UNKNOWN_MANUAL_REVIEW';
      return a.rawProviderStatus === 'rate_limited' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_DECLINED';
    case 'CANCELLED':
      return 'PROVIDER_CANCELLED';
    default:
      return a.manualReview || a.adapterCapability === 'UNSUPPORTED'
        ? 'OUTCOME_UNKNOWN_MANUAL_REVIEW'
        : 'OUTCOME_UNKNOWN_RECONCILING';
  }
}

export interface AttemptView {
  contactAttemptId: string;
  contactRequestId: string;
  attemptNumber: number;
  providerAccountId: string;
  providerAccountRevisionId: string;
  paid: boolean;
  commercialIntentId: string | null;
  executionAuthorityId: string | null;
  approvalId: string | null;
  clientOperationId: string;
  idempotencyKey: string;
  transportState: string;
  externalOutcomeState: string;
  adapterCapability: 'ELIGIBLE' | 'UNSUPPORTED';
  capabilityReason: string | null;
  economicState: string | null;
  rawProviderStatus: string | null;
  providerRef: string | null;
  rawResponseDigest: string | null;
  nextReconcileAt: string | null;
  manualReview: boolean;
  definiteNoEffect: boolean;
  resultOrigin: string;
  adapterClass: string;
  version: number;
  displayStatus: DisplayStatus;
  createdAt: string;
  updatedAt: string;
}

export function toAttemptView(r: AttemptRow): AttemptView {
  const base = {
    contactAttemptId: r.id,
    contactRequestId: r.contact_request_id,
    attemptNumber: r.attempt_number,
    providerAccountId: r.provider_account_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    paid: r.paid,
    commercialIntentId: r.commercial_intent_id,
    executionAuthorityId: r.execution_authority_id,
    approvalId: r.approval_id,
    clientOperationId: r.client_operation_id,
    idempotencyKey: r.idempotency_key,
    transportState: r.transport_state,
    externalOutcomeState: r.external_outcome_state,
    adapterCapability: r.adapter_capability,
    capabilityReason: r.capability_reason,
    economicState: r.economic_state,
    rawProviderStatus: r.raw_provider_status,
    providerRef: r.provider_ref,
    rawResponseDigest: r.raw_response_digest,
    nextReconcileAt: isoOf(r.next_reconcile_at),
    manualReview: r.manual_review,
    definiteNoEffect: r.definite_no_effect,
    resultOrigin: r.result_origin,
    adapterClass: r.adapter_class,
    version: r.version,
    createdAt: isoOf(r.created_at)!,
    updatedAt: isoOf(r.updated_at)!,
  };
  return { ...base, displayStatus: displayStatusOf(base) };
}

const PATCHABLE = [
  'transport_state',
  'external_outcome_state',
  'adapter_capability',
  'capability_reason',
  'economic_state',
  'raw_provider_status',
  'provider_ref',
  'raw_response_digest',
  'next_reconcile_at',
  'manual_review',
  'definite_no_effect',
  'adapter_class',
  'commercial_intent_id',
  'execution_authority_id',
  'last_broker_event_version',
] as const;
export type AttemptPatch = Partial<Record<(typeof PATCHABLE)[number], unknown>>;

/** Compare-and-set update on the attempt version, plus observation and outbox event. */
export async function patchAttempt(
  c: Tx,
  ctx: TenantContext,
  row: AttemptRow,
  patch: AttemptPatch,
  obs: Omit<AttemptObservation, 'transportState' | 'externalOutcomeState' | 'adapterCapability' | 'economicState'>,
  incidentId: string,
): Promise<AttemptRow> {
  const keys = Object.keys(patch).filter((k) => (PATCHABLE as readonly string[]).includes(k));
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  const { rows } = await c.query<AttemptRow>(
    `UPDATE provider_contact_attempts SET ${[...sets, 'version = version + 1', 'updated_at = clock_timestamp()'].join(', ')}
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [row.tenant_id, row.id, row.version, ...keys.map((k) => (patch as Record<string, unknown>)[k])],
  );
  const next = rows[0];
  if (!next) throw versionConflict('ATTEMPT_CHANGED');
  await appendAttemptEvent(c, next.tenant_id, next.id, {
    ...obs,
    transportState: next.transport_state,
    externalOutcomeState: next.external_outcome_state,
    adapterCapability: next.adapter_capability,
    economicState: next.economic_state,
  });
  await emitAttempt(c, ctx, next, incidentId);
  return next;
}

export async function emitAttempt(c: Tx, ctx: TenantContext, r: AttemptRow, incidentId: string): Promise<void> {
  const v = toAttemptView(r);
  await emitProviderEvent(c, ctx, 'provider.contact_attempted.v1', r.id, r.version, {
    contactAttemptId: r.id,
    contactRequestId: r.contact_request_id,
    incidentId,
    providerAccountRevisionId: r.provider_account_revision_id,
    paid: r.paid,
    commercialIntentId: r.commercial_intent_id,
    transportState: r.transport_state,
    externalOutcomeState: r.external_outcome_state,
    adapterCapability: r.adapter_capability,
    economicState: r.economic_state,
    manualReview: r.manual_review,
    definiteNoEffect: r.definite_no_effect,
    nextReconcileAt: v.nextReconcileAt,
    resultOrigin: r.result_origin,
    adapterClass: r.adapter_class,
    displayStatus: v.displayStatus,
  });
}
