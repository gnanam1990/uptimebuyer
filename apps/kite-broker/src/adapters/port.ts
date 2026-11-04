// Broker-owned paid adapter contract (KITE-OPENSERV-INTEGRATION §4). Adapters live ONLY in this app: they are the
// code that touches the paid credential and the paid endpoint. assess/prepare never perform I/O. Every result is a
// normalized outcome with the raw provider status and a raw-response digest; provider payloads stay inside the adapter.
// A timeout, disconnect or unreadable answer is UNKNOWN, never FAILED: FAILED exists only with proof of no effect.

export type ResultOrigin = 'LOCAL_STAND_IN' | 'RECORDED_CONTRACT' | 'KITE_PASSPORT';

export interface AuthorizedIntent {
  tenantId: string;
  commercialIntentId: string;
  actionKind: string;
  semanticOperation: string;
  merchantId: string;
  purpose: string;
  amountMinor: bigint;
  currency: string;
  providerAccountRevisionId: string;
  /** The authority's own confirmed provider session reference; execution must use exactly this session. */
  providerSessionRef: string | null;
}

export interface AuthorizedSessionScope {
  tenantId: string;
  executionAuthorityId: string;
  merchantId: string;
  purpose: string;
  perActionLimitMinor: bigint;
  baseLimitMinor: bigint;
  currency: string;
  expiresAt: string;
  providerAccountRevisionId: string;
}

export interface ClientOperation {
  clientOperationId: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface ReconciliationLocator {
  clientOperationId: string;
  idempotencyKey: string;
  providerRef: string | null;
}

export interface PreparedRequest {
  /** sha256 digest of the exact canonical request the adapter will send. */
  requestDigest: string;
  body: Readonly<Record<string, string>>;
}

export type CapabilityAssessment = { kind: 'ELIGIBLE' } | { kind: 'UNSUPPORTED'; reasonCode: string };

export interface ProviderReturn {
  kind: 'REFUND' | 'REVERSAL';
  providerEventId: string;
  amountMinor: bigint;
}

interface Observed {
  rawProviderStatus: string | null;
  rawResponseDigest: string | null;
  observedAt: string;
}

export type AdapterOutcome =
  | ({ kind: 'ACCEPTED'; providerRef: string | null } & Observed)
  | ({ kind: 'CONFIRMED'; providerRef: string | null; capturedMinor: bigint; returns: ProviderReturn[] } & Observed)
  | ({ kind: 'FAILED'; reasonCode: string; effect: 'NO_EFFECT_PROVED' } & Observed)
  | ({ kind: 'CANCELLED'; providerRef: string | null } & Observed)
  | ({ kind: 'UNKNOWN'; providerRef: string | null; reasonCode: string } & Observed)
  /** Reconciliation capability turned out to be absent (after possible egress): the effect stays UNKNOWN. */
  | ({ kind: 'RECONCILIATION_UNSUPPORTED'; reasonCode: string } & Observed);

export interface SendHooks {
  /** Called once when the request has actually been handed to the network boundary (bytes flushed). */
  onHandoff(): void;
}

export interface ReconciliationCapability {
  /** Authoritative lookup by the pre-egress client operation / idempotency key (no provider reference needed). */
  lookupByClientOperation: boolean;
  /** Provider-enforced same-key idempotent execution whose original result is returned on replay. */
  sameKeyReplay: boolean;
}

export interface PaidAdapter {
  readonly adapterId: string;
  readonly resultOrigin: ResultOrigin;
  readonly capability: ReconciliationCapability;
  assess(intent: AuthorizedIntent): CapabilityAssessment;
  prepare(intent: AuthorizedIntent): PreparedRequest;
  execute(request: PreparedRequest, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome>;
  lookup(locator: ReconciliationLocator): Promise<AdapterOutcome>;
  cancel?(locator: ReconciliationLocator): Promise<AdapterOutcome>;
  assessSession(scope: AuthorizedSessionScope): CapabilityAssessment;
  activateSession(scope: AuthorizedSessionScope, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome>;
  lookupSession(locator: ReconciliationLocator): Promise<AdapterOutcome>;
}

export const autonomousRecovery = (c: ReconciliationCapability) => c.lookupByClientOperation || c.sameKeyReplay;

/** The adapter used when no paid adapter is explicitly configured: everything is UNSUPPORTED, and it has no I/O. */
export class UnconfiguredAdapter implements PaidAdapter {
  readonly adapterId = 'unconfigured';
  readonly resultOrigin = 'RECORDED_CONTRACT' as const;
  readonly capability = { lookupByClientOperation: false, sameKeyReplay: false };
  assess(): CapabilityAssessment {
    return { kind: 'UNSUPPORTED', reasonCode: 'NO_PAID_ADAPTER_CONFIGURED' };
  }
  assessSession(): CapabilityAssessment {
    return { kind: 'UNSUPPORTED', reasonCode: 'NO_PAID_ADAPTER_CONFIGURED' };
  }
  prepare(): PreparedRequest {
    throw new Error('unconfigured adapter cannot prepare');
  }
  async execute(): Promise<AdapterOutcome> {
    throw new Error('unconfigured adapter cannot execute');
  }
  async lookup(): Promise<AdapterOutcome> {
    return unsupported('NO_PAID_ADAPTER_CONFIGURED');
  }
  async activateSession(): Promise<AdapterOutcome> {
    throw new Error('unconfigured adapter cannot activate');
  }
  async lookupSession(): Promise<AdapterOutcome> {
    return unsupported('NO_PAID_ADAPTER_CONFIGURED');
  }
}

export const unsupported = (reasonCode: string): AdapterOutcome => ({
  kind: 'RECONCILIATION_UNSUPPORTED',
  reasonCode,
  rawProviderStatus: null,
  rawResponseDigest: null,
  observedAt: new Date().toISOString(),
});
