// Unpaid provider execution ports (NFR-11). Adapters are bound to one provider key, receive the exact pinned
// account revision on every call, and return normalized results with the raw provider status and a raw-response
// digest. Only M07-owned unpaid revisions ever reach an adapter; paid revisions are routed to the broker port and
// no adapter here can hold or resolve a paid credential (INV-06).
import type { ProviderSearchPage, WireQuote } from './schemas.js';

/** Pre-egress adapter capability (separate axis from any external outcome). */
export type AdapterCapabilityAssessment =
  { readonly kind: 'ELIGIBLE' } | { readonly kind: 'UNSUPPORTED'; readonly reasonCode: string };

/** Evidence class of an adapter's results. Only LIVE could ever be real-world evidence (and no LIVE run exists). */
export const ADAPTER_CLASSES = Object.freeze([
  'LIVE',
  'SANDBOX',
  'RECORDED_FIXTURE',
  'SYNTHETIC_FIXTURE',
  'LOCAL_FAKE',
] as const);
export type AdapterClass = (typeof ADAPTER_CLASSES)[number];

export type ProviderOperation = 'SEARCH' | 'CONTACT_PHONE' | 'CONTACT_EMAIL' | 'CONTACT_API';

/** The immutable account revision an operation is pinned to (credential material is never part of it). */
export interface PinnedRevision {
  readonly providerAccountId: string;
  readonly providerAccountRevisionId: string;
  readonly providerKey: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly capabilities: readonly string[];
  readonly endpointPolicyDigest: string;
}

/** Resolves the unpaid credential of a pinned M07-owned revision; never called for a broker-owned revision. */
export type UnpaidCredential = () => Promise<Uint8Array | undefined>;

export interface CallContext {
  readonly revision: PinnedRevision;
  readonly signal: AbortSignal;
  readonly credential: UnpaidCredential;
}

export interface SearchPageRequest {
  readonly query: {
    providerKinds: readonly string[];
    country: string;
    postalCode: string | null;
  };
  readonly cursor: string | null;
  readonly pageSize: number;
}

export type SearchPageResult =
  | { readonly kind: 'PAGE'; readonly page: ProviderSearchPage; readonly rawResponseDigest: string }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterMs: number; readonly rawResponseDigest: string }
  | {
      readonly kind: 'ERROR';
      readonly reasonCode: 'PROVIDER_ERROR' | 'RESPONSE_SCHEMA_INVALID' | 'INVALID_REQUEST';
      readonly rawResponseDigest: string | null;
    };

export interface ContactExecution {
  readonly clientOperationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly channel: 'PHONE' | 'EMAIL' | 'API';
  /** Destination contact value (restricted; adapters must not log it). */
  readonly destination: string;
  readonly purposeCode: string;
  readonly message: { readonly subject: string; readonly body: string; readonly disclosure: string | null };
}

export interface ObservedConsent {
  readonly recording: 'GRANTED' | 'DECLINED' | 'NOT_APPLICABLE';
  readonly processing: 'GRANTED' | 'DECLINED';
}

export type ContactResult =
  | {
      readonly kind: 'ACCEPTED' | 'CONFIRMED';
      readonly providerRef: string | null;
      readonly rawStatus: string;
      readonly rawResponseDigest: string;
      readonly quote: WireQuote | null;
      readonly consent: ObservedConsent | null;
    }
  | {
      /** Definitive synchronous decline: authoritative proof of no effect. */
      readonly kind: 'DECLINED';
      readonly rawStatus: string;
      readonly reasonCode: string;
      readonly rawResponseDigest: string;
    }
  | {
      /** Refused before acceptance (429): definitive no effect; never retried tightly. */
      readonly kind: 'RATE_LIMITED';
      readonly retryAfterMs: number;
      readonly rawResponseDigest: string;
    };

export type LookupResult =
  | {
      readonly kind: 'FOUND';
      readonly state: 'ACCEPTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
      readonly providerRef: string | null;
      readonly rawStatus: string;
      readonly rawResponseDigest: string;
      readonly quote: WireQuote | null;
    }
  /** The provider does not (yet) know the operation; absence alone is never proof of no effect. */
  | { readonly kind: 'NOT_FOUND'; readonly rawResponseDigest: string }
  | { readonly kind: 'PENDING'; readonly rawResponseDigest: string | null }
  /** Authoritative lookup is not available for this account: capability becomes UNSUPPORTED after egress. */
  | { readonly kind: 'UNSUPPORTED'; readonly reasonCode: string };

/** Thrown by an adapter when it can prove the request never left the process (no effect possible). */
export class NotSentError extends Error {
  constructor(readonly reasonCode: string) {
    super('The provider request was not sent.');
    this.name = 'NotSentError';
  }
}

export interface ContactObserver {
  /** Called when the request is observed handed to the network boundary (external outcome REQUESTED). */
  handedOff(): void;
}

export interface UnpaidProviderAdapter {
  readonly providerKey: string;
  readonly adapterClass: AdapterClass;
  /** Channels this adapter can contact through. */
  readonly channels: readonly ('PHONE' | 'EMAIL' | 'API')[];
  readonly supportsSearch: boolean;
  /** Pre-egress capability: ELIGIBLE only when authoritative lookup or same-key replay can reconcile a timeout. */
  assess(revision: PinnedRevision, op: ProviderOperation): AdapterCapabilityAssessment;
  search?(req: SearchPageRequest, ctx: CallContext): Promise<SearchPageResult>;
  contact?(req: ContactExecution, ctx: CallContext, observer: ContactObserver): Promise<ContactResult>;
  lookup?(
    loc: {
      clientOperationId: string;
      idempotencyKey: string;
      providerRef: string | null;
      channel: 'PHONE' | 'EMAIL' | 'API';
    },
    ctx: CallContext,
  ): Promise<LookupResult>;
}

export interface ProviderAdapterRegistry {
  /** The adapter for a provider key and operation, if one is configured. */
  find(providerKey: string, op: ProviderOperation): UnpaidProviderAdapter | undefined;
  list(): readonly UnpaidProviderAdapter[];
}

const opChannel = (op: ProviderOperation) =>
  op === 'SEARCH' ? null : (op.slice('CONTACT_'.length) as 'PHONE' | 'EMAIL' | 'API');

export class StaticAdapterRegistry implements ProviderAdapterRegistry {
  private readonly adapters: readonly UnpaidProviderAdapter[];
  constructor(adapters: readonly UnpaidProviderAdapter[]) {
    this.adapters = Object.freeze([...adapters]);
  }
  find(providerKey: string, op: ProviderOperation): UnpaidProviderAdapter | undefined {
    const ch = opChannel(op);
    return this.adapters.find(
      (a) => a.providerKey === providerKey && (ch === null ? a.supportsSearch : a.channels.includes(ch)),
    );
  }
  list(): readonly UnpaidProviderAdapter[] {
    return this.adapters;
  }
}

/** Explicit bounds for every adapter call (NFR-04). */
export const ADAPTER_BOUNDS = Object.freeze({
  maxResponseBytes: 256 * 1024,
  minTimeoutMs: 100,
  maxTimeoutMs: 60_000,
  defaultContactTimeoutMs: 15_000,
  defaultSearchTimeoutMs: 10_000,
  /** Requests per revision per second (token bucket). */
  ratePerSecond: 5,
  burst: 10,
});
