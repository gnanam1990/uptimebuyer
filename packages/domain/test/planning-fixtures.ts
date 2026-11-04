// Fixtures for the M08 pure planning tests (T-033..T-036). Every value is a synthetic golden-vector input with
// explicit provenance; nothing here is a real quote, tenant estimate or inventory record.
import type { CurrencyCode } from '@uptimebuyer/contracts';
import type {
  CostInputs,
  DeadlineInput,
  MoneyInput,
  PlanCandidateInput,
  PlanEconomics,
  PpmInput,
  Provenance,
  RecoveryPlanInput,
} from '../src/index.js';

export const EVALUATED_AT = '2026-11-05T10:00:00.000Z';
export const MINUTE = 60_000;

export const prov = (source: Provenance['source'], ref: string, revision: number | null = 1): Provenance => ({
  source,
  ref,
  revision,
  asOf: '2026-11-05T09:30:00.000Z',
});

export const usd = (amountMinor: bigint, source: Provenance['source'], ref: string): MoneyInput => ({
  amountMinor,
  currency: 'USD',
  provenance: prov(source, ref),
});

export const ppmOf = (estimatePpm: number, ref: string, lowPpm = estimatePpm, highPpm = estimatePpm): PpmInput => ({
  estimatePpm,
  lowPpm,
  highPpm,
  provenance: prov('TENANT_RISK_ESTIMATE', ref),
});

export function deadlineAt(iso: string, over: Partial<DeadlineInput> = {}): DeadlineInput {
  return {
    currentResponseDeadlineAt: iso,
    status: 'RUNNING',
    eventSequence: 1,
    procedureRevisionId: 'opr_cold-chain-r1',
    provenance: prov('INCIDENT_DEADLINE_PROJECTION', 'inc_golden-0001', 1),
    ...over,
  };
}

/** Golden vector V1: $185.00 part, 25 min ETA, $60/h downtime, 5% / 60% inventory loss, $5,000 stock, 2% x $400. */
export function v1Inputs(over: Partial<CostInputs> = {}): CostInputs {
  return {
    currency: 'USD',
    purchaseOrService: usd(18_500n, 'CANDIDATE_ACTION', 'cand_golden-0001'),
    expectedDelay: { ms: 25 * MINUTE, provenance: prov('PROVIDER_QUOTE', 'pqt_golden-0001') },
    downtimeCostPerHour: usd(6_000n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
    inventoryLossWithinDeadline: ppmOf(50_000, 'tre_golden-0001', 30_000, 80_000),
    inventoryLossPastDeadline: ppmOf(600_000, 'tre_golden-0001', 400_000, 800_000),
    inventoryValue: usd(500_000n, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001'),
    repeatFailureProbability: ppmOf(20_000, 'tre_golden-0001', 10_000, 40_000),
    repeatFailureCost: usd(40_000n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
    ...over,
  };
}

/** Everything zero except the named overrides (for isolating one component). */
export function zeroInputs(over: Partial<CostInputs> = {}): CostInputs {
  return v1Inputs({
    purchaseOrService: usd(0n, 'CANDIDATE_ACTION', 'cand_golden-0002'),
    expectedDelay: { ms: 0, provenance: prov('PROVIDER_QUOTE', 'pqt_golden-0002') },
    downtimeCostPerHour: usd(0n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
    inventoryLossWithinDeadline: ppmOf(0, 'tre_golden-0001'),
    inventoryLossPastDeadline: ppmOf(0, 'tre_golden-0001'),
    inventoryValue: usd(0n, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001'),
    repeatFailureProbability: ppmOf(0, 'tre_golden-0001'),
    repeatFailureCost: usd(0n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
    ...over,
  });
}

export const economics = (over: Partial<PlanEconomics> = {}): PlanEconomics => ({
  riskEstimateId: 'tre_golden-0001',
  revision: 1,
  currency: 'USD' as CurrencyCode,
  downtimeCostPerHour: usd(6_000n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
  inventoryLossWithinDeadline: ppmOf(50_000, 'tre_golden-0001'),
  inventoryLossPastDeadline: ppmOf(600_000, 'tre_golden-0001'),
  repeatFailureCost: usd(40_000n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
  ...over,
});

export function candidate(
  id: string,
  priceMinor: bigint,
  etaMinutes: number,
  over: Partial<PlanCandidateInput> = {},
): PlanCandidateInput {
  return {
    candidateId: id,
    actionDigest: `action.v1:sha256:${Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)}`,
    actionKind: 'PART_PURCHASE',
    compatibilityDecisionId: `cmp_${id.slice(5)}`,
    quoteId: `pqt_${id.slice(5)}`,
    eligibility: { status: 'ALLOW_EXECUTABLE' },
    providerScore: 1_000_000,
    purchaseOrService: usd(priceMinor, 'CANDIDATE_ACTION', id),
    expectedDelay: { ms: etaMinutes * MINUTE, provenance: prov('PROVIDER_QUOTE', `pqt_${id.slice(5)}`) },
    repeatFailureProbability: ppmOf(20_000, 'tre_golden-0001'),
    issues: [],
    ...over,
  };
}

export function planInput(candidates: PlanCandidateInput[], over: Partial<RecoveryPlanInput> = {}): RecoveryPlanInput {
  return {
    binding: {
      tenantId: 'ten_golden-0001',
      incidentId: 'inc_golden-0001',
      assetRevisionId: 'arv_golden-0001',
      evidenceRevisionId: 'evr_golden-0001',
      policyRevisionId: 'pol_golden-0001',
    },
    evaluatedAt: EVALUATED_AT,
    deadline: deadlineAt('2026-11-05T10:30:00.000Z'),
    economics: economics(),
    inventoryValue: usd(500_000n, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001'),
    candidates,
    ...over,
  };
}

/** Deterministic xorshift PRNG for property tests (no Math.random, so failures replay exactly). */
export function prng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return { int: (lo: number, hi: number) => lo + (next() % (hi - lo + 1)), next };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const r = prng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
