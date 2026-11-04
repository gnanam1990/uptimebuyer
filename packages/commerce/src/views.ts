// Row -> contract view mappers. Every view keeps transport, external outcome, adapter capability and economic or
// authority state as separate fields (API-EVENT-SPEC §1); none exposes a credential or credential reference.
import {
  CommercialIntentSchema,
  ExecutionAuthoritySchema,
  ExternalAttemptSchema,
  KiteSessionSchema,
  decodeWire,
  encodeWire,
  type CommercialIntent,
  type ExecutionAuthority,
  type ExternalAttempt,
  type KiteSession,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import type { AuthorityScope } from './signing.js';
import { isoNN, isoOf } from './internal.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const clean = <S extends Parameters<typeof decodeWire>[0]>(schema: S, value: unknown) =>
  decodeWire(schema, encodeWire(schema, value as never));

export function authorityScopeOf(r: any): AuthorityScope {
  return {
    tenantId: r.tenant_id,
    executionAuthorityId: r.id,
    approvalId: r.approval_id,
    incidentId: r.incident_id,
    siteId: r.site_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    planHash: r.plan_hash,
    actionDigest: r.action_digest,
    subject: { type: r.subject_type, id: r.subject_id },
    semanticOperation: r.semantic_operation,
    providerAccountId: r.provider_account_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    merchantId: r.merchant_id,
    purpose: r.purpose,
    allowedActionKinds: [...r.allowed_action_kinds],
    perActionLimit: { amountMinor: BigInt(r.per_action_limit_minor), currency: r.currency },
    baseLimit: { amountMinor: BigInt(r.base_limit_minor), currency: r.currency },
    issuedAt: isoNN(r.issued_at),
    expiresAt: isoNN(r.expires_at),
  };
}

export const authoritySignatureOf = (r: any) => ({
  algorithm: r.signature_algorithm as string,
  keyId: r.signature_key_id as string,
  value: r.signature_value as string,
  scopeDigest: r.scope_digest as string,
});

export function toExecutionAuthority(r: any): ExecutionAuthority {
  return clean(ExecutionAuthoritySchema, {
    executionAuthorityId: r.id,
    tenantId: r.tenant_id,
    approvalId: r.approval_id,
    incidentId: r.incident_id,
    assetRevisionId: r.asset_revision_id,
    evidenceRevisionId: r.evidence_revision_id,
    policyRevisionId: r.policy_revision_id,
    planHash: r.plan_hash,
    actionDigest: r.action_digest,
    providerAccountRevisionId: r.provider_account_revision_id,
    merchantId: r.merchant_id,
    purpose: r.purpose,
    allowedActionKinds: r.allowed_action_kinds,
    perActionLimit: { amountMinor: BigInt(r.per_action_limit_minor), currency: r.currency },
    baseLimit: { amountMinor: BigInt(r.base_limit_minor), currency: r.currency },
    issuedAt: isoNN(r.issued_at),
    expiresAt: isoNN(r.expires_at),
    status: r.status,
    signatureDigest: r.scope_digest,
    version: r.version,
  }) as ExecutionAuthority;
}

export function toKiteSession(r: any): KiteSession {
  return clean(KiteSessionSchema, {
    kiteSessionId: r.id,
    tenantId: r.tenant_id,
    executionAuthorityId: r.execution_authority_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    clientOperationId: r.client_operation_id,
    idempotencyKey: r.idempotency_key,
    requestDigest: r.request_digest,
    transportState: r.transport_state,
    externalOutcomeState: r.external_outcome_state,
    adapterCapability: r.adapter_capability,
    providerSessionRef: r.provider_session_ref,
    nextReconcileAt: isoOf(r.next_reconcile_at),
  }) as KiteSession;
}

export function toCommercialIntent(r: any): CommercialIntent {
  return clean(CommercialIntentSchema, {
    commercialIntentId: r.id,
    tenantId: r.tenant_id,
    incidentId: r.incident_id,
    assetRevisionId: r.asset_revision_id,
    subject: { type: r.subject_type, id: r.subject_id },
    approvalId: r.approval_id,
    executionAuthorityId: r.execution_authority_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    actionDigest: r.action_digest,
    maxAmount: { amountMinor: BigInt(r.max_amount_minor), currency: r.currency },
    state: r.state,
    supersedesIntentId: r.supersedes_intent_id,
    version: r.version,
    createdAt: isoNN(r.created_at),
  }) as CommercialIntent;
}

export function toExternalAttempt(r: any): ExternalAttempt {
  return clean(ExternalAttemptSchema, {
    externalAttemptId: r.id,
    tenantId: r.tenant_id,
    commercialIntentId: r.intent_id,
    providerAccountRevisionId: r.provider_account_revision_id,
    clientOperationId: r.client_operation_id,
    idempotencyKey: r.idempotency_key,
    requestDigest: r.request_digest,
    transportState: r.transport_state,
    externalOutcomeState: r.external_outcome_state,
    adapterCapability: r.adapter_capability,
    providerRef: r.provider_ref,
    rawProviderStatus: r.raw_provider_status,
    nextReconcileAt: isoOf(r.next_reconcile_at),
  }) as ExternalAttempt;
}

export interface BudgetProjection {
  budgetAccountId: string;
  currency: string;
  baseLimitMinor: bigint;
  approvedAdjustmentsMinor: bigint;
  effectiveLimitMinor: bigint;
  openReservedMinor: bigint;
  grossCapturedMinor: bigint;
  refundedMinor: bigint;
  reversedMinor: bigint;
  netSettledMinor: bigint;
  availableMinor: bigint;
  version: number;
}

export const toBudget = (r: any): BudgetProjection => ({
  budgetAccountId: r.id,
  currency: r.currency,
  baseLimitMinor: BigInt(r.base_limit_minor),
  approvedAdjustmentsMinor: BigInt(r.approved_adjustments_minor),
  effectiveLimitMinor: BigInt(r.effective_limit_minor),
  openReservedMinor: BigInt(r.open_reserved_minor),
  grossCapturedMinor: BigInt(r.gross_captured_minor),
  refundedMinor: BigInt(r.refunded_minor),
  reversedMinor: BigInt(r.reversed_minor),
  netSettledMinor: BigInt(r.net_settled_minor),
  availableMinor: BigInt(r.available_minor),
  version: r.version,
});

export interface IntentMoney {
  maxAmountMinor: bigint;
  openReservedMinor: bigint;
  capturedGrossMinor: bigint;
  refundedMinor: bigint;
  reversedMinor: bigint;
  netSettledMinor: bigint;
  currency: string;
}
export const toIntentMoney = (r: any): IntentMoney => ({
  maxAmountMinor: BigInt(r.max_amount_minor),
  openReservedMinor: BigInt(r.open_reserved_minor),
  capturedGrossMinor: BigInt(r.captured_gross_minor),
  refundedMinor: BigInt(r.refunded_minor),
  reversedMinor: BigInt(r.reversed_minor),
  netSettledMinor: BigInt(r.net_settled_minor),
  currency: r.currency,
});

export const nowIso = (): UtcInstant => new Date().toISOString() as UtcInstant;
/* eslint-enable @typescript-eslint/no-explicit-any */
