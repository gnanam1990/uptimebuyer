// Paid provider CANDIDATES (KITE-OPENSERV-INTEGRATION §5): StablePhone, StableEmail and StableEnrich were observed as
// point-in-time Kite catalog candidates; their availability, price, schema and fulfillment are NOT_RUN. In M07 they
// exist only as configuration-gated shells that describe the candidate and always report UNSUPPORTED: without
// configuration because nothing is configured, and with configuration because paid egress and paid credentials are
// owned exclusively by the M09 broker (INV-06). No shell performs network I/O or reads a credential.
import { dependency } from '../errors.js';
import type { AdapterCapabilityAssessment } from '../ports.js';

export const PAID_CANDIDATE_PROVIDERS = Object.freeze(['stablephone', 'stableemail', 'stableenrich'] as const);
export type PaidCandidateProvider = (typeof PAID_CANDIDATE_PROVIDERS)[number];

const ROLE: Record<PaidCandidateProvider, { semanticOperation: 'PAID_CONTACT' | 'PAID_LOOKUP'; channel: string }> = {
  stablephone: { semanticOperation: 'PAID_CONTACT', channel: 'PHONE' },
  stableemail: { semanticOperation: 'PAID_CONTACT', channel: 'EMAIL' },
  stableenrich: { semanticOperation: 'PAID_LOOKUP', channel: 'SEARCH' },
};

export interface PaidCandidateShell {
  readonly provider: PaidCandidateProvider;
  readonly paid: true;
  readonly ownerService: 'KITE_BROKER_PAID';
  readonly semanticOperation: 'PAID_CONTACT' | 'PAID_LOOKUP';
  readonly channel: string;
  /** Point-in-time catalog reference from configuration (e.g. a catalog snapshot date), never a credential. */
  readonly catalogRef: string | null;
  readonly fulfillment: 'NOT_RUN';
  assess(): AdapterCapabilityAssessment;
  execute(): Promise<never>;
}

/**
 * Describe a paid candidate. `env` may carry UPTIMEBUYER_CANDIDATE_<NAME>=<catalog reference>; any value only marks
 * the candidate as catalogued for M09, it never enables M07 execution.
 */
export function paidCandidateShell(
  provider: PaidCandidateProvider,
  env: Readonly<Record<string, string | undefined>> = {},
): PaidCandidateShell {
  const raw = env[`UPTIMEBUYER_CANDIDATE_${provider.toUpperCase()}`];
  const catalogRef = raw && /^[A-Za-z0-9._:-]{1,64}$/.test(raw) ? raw : null;
  return Object.freeze({
    provider,
    paid: true as const,
    ownerService: 'KITE_BROKER_PAID' as const,
    ...ROLE[provider],
    catalogRef,
    fulfillment: 'NOT_RUN' as const,
    assess: (): AdapterCapabilityAssessment =>
      catalogRef === null
        ? { kind: 'UNSUPPORTED', reasonCode: 'CANDIDATE_NOT_CONFIGURED' }
        : { kind: 'UNSUPPORTED', reasonCode: 'PAID_EGRESS_BROKER_ONLY' },
    execute: async (): Promise<never> => {
      throw dependency(catalogRef === null ? 'CANDIDATE_NOT_CONFIGURED' : 'PAID_EGRESS_BROKER_ONLY');
    },
  });
}
