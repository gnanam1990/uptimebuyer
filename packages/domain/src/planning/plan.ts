// Recovery-plan evaluation (FR-09, INV-03, INV-04, M08). Pure and deterministic: it ranks only candidates whose
// deterministic compatibility decision is ALLOW and executable for the current action digest; HOLD, REJECT,
// not-executable and undecided candidates are listed with reasons and never priced or ranked. Evidence sufficiency
// is such a gate, never a price adjustment. If any eligible candidate lacks a mandatory economic input, the plan is
// INCOMPLETE: nothing is presented as a winner. Ranking uses the documented stable rule
//   expected cost asc, recovery ETA asc, provider score desc, candidate ID asc (UTF-16 code units, locale-free)
// and the plan hash binds the revision tuple, deadline projection, economic input revisions, every candidate's
// action digest, decision and quote, the computed components and the ranking (not the wall-clock evaluation time).
import { DomainError, type CurrencyCode, type VersionedDigest } from '@uptimebuyer/contracts';
import { canonicalDigest } from '../canonical.js';
import {
  PLANNING_RULE_VERSION,
  computeCostToRecovery,
  type CostResult,
  type DeadlineInput,
  type DelayInput,
  type InputIssue,
  type MoneyInput,
  type PpmInput,
} from './cost.js';

export const PLAN_HASH_DOMAIN = 'recovery-plan';
export const PLAN_HASH_VERSION = 1;
export const MAX_PLAN_CANDIDATES = 50;
export const PLAN_TIE_BREAK_RULE = Object.freeze([
  'EXPECTED_COST_ASC',
  'RECOVERY_ETA_ASC',
  'PROVIDER_SCORE_DESC',
  'CANDIDATE_ID_ASC_UTF16',
] as const);

export type CandidateEligibility =
  | { readonly status: 'ALLOW_EXECUTABLE' }
  | {
      readonly status: 'POLICY_HOLD' | 'POLICY_REJECT' | 'NOT_EXECUTABLE' | 'NO_DECISION';
      readonly reasonCodes: readonly string[];
    };

export interface PlanCandidateInput {
  readonly candidateId: string;
  readonly actionDigest: string;
  readonly actionKind: string;
  readonly compatibilityDecisionId: string | null;
  readonly quoteId: string | null;
  readonly eligibility: CandidateEligibility;
  /** Deterministic provider score 0..1_000_000 (higher is better); null when not established. */
  readonly providerScore: number | null;
  readonly purchaseOrService: MoneyInput | null;
  readonly expectedDelay: DelayInput | null;
  readonly repeatFailureProbability: PpmInput | null;
  /** Assembly findings (e.g. the quote does not match the candidate); any issue makes the candidate incomplete. */
  readonly issues: readonly InputIssue[];
}

/** The versioned tenant risk estimate's economics. */
export interface PlanEconomics {
  readonly riskEstimateId: string;
  readonly revision: number;
  readonly currency: CurrencyCode;
  readonly downtimeCostPerHour: MoneyInput;
  readonly inventoryLossWithinDeadline: PpmInput;
  readonly inventoryLossPastDeadline: PpmInput;
  readonly repeatFailureCost: MoneyInput;
}

export interface RecoveryPlanInput {
  readonly binding: {
    readonly tenantId: string;
    readonly incidentId: string;
    readonly assetRevisionId: string;
    readonly evidenceRevisionId: string;
    readonly policyRevisionId: string;
  };
  readonly evaluatedAt: string;
  readonly deadline: DeadlineInput | null;
  readonly economics: PlanEconomics | null;
  readonly inventoryValue: MoneyInput | null;
  readonly candidates: readonly PlanCandidateInput[];
}

export type PlanOutcome = 'RANKED' | 'INCOMPLETE' | 'NO_ELIGIBLE_CANDIDATE';
export type CandidateDisposition = 'RANKED' | 'ELIGIBLE_UNRANKED' | 'INCOMPLETE' | 'HELD' | 'REJECTED';

export interface EvaluatedCandidate {
  readonly candidateId: string;
  readonly actionDigest: string;
  readonly actionKind: string;
  readonly compatibilityDecisionId: string | null;
  readonly quoteId: string | null;
  readonly disposition: CandidateDisposition;
  readonly ordinal: number | null;
  readonly reasonCodes: string[];
  readonly providerScore: number | null;
  /** null for HOLD/REJECT/not-executable candidates: they are never priced. */
  readonly cost: CostResult | null;
}

export interface RecoveryPlanEvaluation {
  readonly ruleVersion: string;
  readonly tieBreakRule: readonly string[];
  readonly outcome: PlanOutcome;
  readonly incomplete: boolean;
  readonly holdReasons: string[];
  /** Ranked candidates by ordinal, then every other candidate by candidate ID. */
  readonly candidates: EvaluatedCandidate[];
  readonly ranking: string[] | null;
  readonly planHash: VersionedDigest;
}

const invalid = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', `Recovery plan input failed validation: ${reasonCode}.`, { reasonCode });

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

const codeOf = (i: InputIssue) =>
  i.detail ?? `${i.field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_${i.reason}`.replace(/[^A-Z0-9_]/g, '_');

/** The documented total order over ranked candidates (both must carry a complete cost and a provider score). */
export function compareRankedCandidates(a: EvaluatedCandidate, b: EvaluatedCandidate): number {
  const ca = a.cost?.expectedCostMinor;
  const cb = b.cost?.expectedCostMinor;
  if (typeof ca !== 'bigint' || typeof cb !== 'bigint' || a.providerScore === null || b.providerScore === null)
    throw invalid('UNRANKABLE_CANDIDATE');
  const da = BigInt(a.cost!.inputs.find((i) => i.field === 'expectedDelay')!.value!);
  const db = BigInt(b.cost!.inputs.find((i) => i.field === 'expectedDelay')!.value!);
  return cmpBig(ca, cb) || cmpBig(da, db) || b.providerScore - a.providerScore || cmpStr(a.candidateId, b.candidateId);
}

const ID_RE = /^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;

export function evaluateRecoveryPlan(input: RecoveryPlanInput): RecoveryPlanEvaluation {
  if (!input || !Array.isArray(input.candidates)) throw invalid('INVALID_PLAN_INPUT');
  if (input.candidates.length > MAX_PLAN_CANDIDATES) throw invalid('TOO_MANY_CANDIDATES');
  const seen = new Set<string>();
  const digests = new Set<string>();
  for (const c of input.candidates) {
    if (typeof c.candidateId !== 'string' || !ID_RE.test(c.candidateId)) throw invalid('INVALID_CANDIDATE_ID');
    if (seen.has(c.candidateId)) throw invalid('DUPLICATE_CANDIDATE');
    if (digests.has(c.actionDigest)) throw invalid('DUPLICATE_CANDIDATE_ACTION_DIGEST');
    seen.add(c.candidateId);
    digests.add(c.actionDigest);
  }
  const econ = input.economics;
  const evaluated: EvaluatedCandidate[] = input.candidates.map((c) => {
    const base = {
      candidateId: c.candidateId,
      actionDigest: c.actionDigest,
      actionKind: c.actionKind,
      compatibilityDecisionId: c.compatibilityDecisionId,
      quoteId: c.quoteId,
      ordinal: null,
      providerScore: c.providerScore,
    };
    if (c.eligibility.status !== 'ALLOW_EXECUTABLE')
      return {
        ...base,
        disposition: c.eligibility.status === 'POLICY_REJECT' ? 'REJECTED' : 'HELD',
        reasonCodes: [...new Set<string>(c.eligibility.reasonCodes)].sort(),
        cost: null,
      };
    const computed = computeCostToRecovery(
      {
        currency: econ?.currency ?? null,
        purchaseOrService: c.purchaseOrService,
        expectedDelay: c.expectedDelay,
        downtimeCostPerHour: econ?.downtimeCostPerHour ?? null,
        inventoryLossWithinDeadline: econ?.inventoryLossWithinDeadline ?? null,
        inventoryLossPastDeadline: econ?.inventoryLossPastDeadline ?? null,
        inventoryValue: input.inventoryValue,
        repeatFailureProbability: c.repeatFailureProbability,
        repeatFailureCost: econ?.repeatFailureCost ?? null,
      },
      { evaluatedAt: input.evaluatedAt, deadline: input.deadline },
    );
    const extra: InputIssue[] = [...c.issues];
    const score = c.providerScore;
    if (score === null || !Number.isSafeInteger(score) || score < 0 || score > 1_000_000)
      extra.push({
        field: 'providerScore',
        reason: score === null ? 'MISSING' : 'INVALID',
        detail: score === null ? 'PROVIDER_SCORE_MISSING' : 'PROVIDER_SCORE_INVALID',
      });
    const cost: CostResult =
      extra.length === 0
        ? computed
        : {
            ...computed,
            complete: false,
            issues: [...extra, ...computed.issues],
            expectedCostMinor: null,
            exactTotal: null,
            components: [],
            range: null,
            deadlinePenaltyMinor: null,
            deadlineFit: null,
            recoveryEtaAt: null,
          };
    return cost.complete
      ? { ...base, disposition: 'RANKED', reasonCodes: [], cost }
      : { ...base, disposition: 'INCOMPLETE', reasonCodes: [...new Set(cost.issues.map(codeOf))].sort(), cost };
  });

  const eligible = evaluated.filter((c) => c.disposition === 'RANKED' || c.disposition === 'INCOMPLETE');
  const outcome: PlanOutcome =
    eligible.length === 0
      ? 'NO_ELIGIBLE_CANDIDATE'
      : eligible.some((c) => c.disposition === 'INCOMPLETE')
        ? 'INCOMPLETE'
        : 'RANKED';

  let ordered: EvaluatedCandidate[];
  let ranking: string[] | null = null;
  const others = (xs: EvaluatedCandidate[]) => [...xs].sort((a, b) => cmpStr(a.candidateId, b.candidateId));
  if (outcome === 'RANKED') {
    const ranked = [...eligible].sort(compareRankedCandidates).map((c, i) => ({ ...c, ordinal: i + 1 }));
    ranking = ranked.map((c) => c.candidateId);
    ordered = [...ranked, ...others(evaluated.filter((c) => c.disposition !== 'RANKED'))];
  } else {
    ordered = others(
      evaluated.map((c) => (c.disposition === 'RANKED' ? { ...c, disposition: 'ELIGIBLE_UNRANKED' as const } : c)),
    );
  }
  const holdReasons =
    outcome === 'RANKED' ? [] : outcome === 'INCOMPLETE' ? ['ECONOMIC_INPUT_INCOMPLETE'] : ['NO_ELIGIBLE_CANDIDATE'];

  const planHash = canonicalDigest(PLAN_HASH_DOMAIN, PLAN_HASH_VERSION, {
    ruleVersion: PLANNING_RULE_VERSION,
    tieBreakRule: [...PLAN_TIE_BREAK_RULE],
    binding: { ...input.binding },
    deadline: input.deadline
      ? {
          currentResponseDeadlineAt: input.deadline.currentResponseDeadlineAt,
          status: input.deadline.status,
          eventSequence: input.deadline.eventSequence,
          procedureRevisionId: input.deadline.procedureRevisionId,
        }
      : null,
    economics: econ ? { riskEstimateId: econ.riskEstimateId, revision: econ.revision, currency: econ.currency } : null,
    inventory: input.inventoryValue
      ? {
          ref: input.inventoryValue.provenance?.ref ?? null,
          revision: input.inventoryValue.provenance?.revision ?? null,
          amountMinor: typeof input.inventoryValue.amountMinor === 'bigint' ? input.inventoryValue.amountMinor : null,
          currency: input.inventoryValue.currency ?? null,
        }
      : null,
    outcome,
    ranking,
    candidates: [...ordered]
      .sort((a, b) => cmpStr(a.candidateId, b.candidateId))
      .map((c) => ({
        candidateId: c.candidateId,
        actionDigest: c.actionDigest,
        actionKind: c.actionKind,
        compatibilityDecisionId: c.compatibilityDecisionId,
        quoteId: c.quoteId,
        disposition: c.disposition,
        ordinal: c.ordinal,
        reasonCodes: c.reasonCodes,
        providerScore: Number.isSafeInteger(c.providerScore) ? c.providerScore : null,
        cost: c.cost
          ? {
              complete: c.cost.complete,
              expectedCostMinor: c.cost.expectedCostMinor,
              deadlineFit: c.cost.deadlineFit,
              issues: c.cost.issues.map((i) => ({ field: i.field, reason: i.reason, detail: i.detail ?? null })),
              components: c.cost.components.map((k) => ({ key: k.key, num: k.exact.num, den: k.exact.den })),
              inputs: c.cost.inputs.map((x) => ({
                field: x.field,
                value: x.value,
                currency: x.currency,
                status: x.status,
                ref: x.provenance?.ref ?? null,
                revision: x.provenance?.revision ?? null,
                uncertainty: x.uncertainty ? { low: x.uncertainty.low, high: x.uncertainty.high } : null,
              })),
            }
          : null,
      })),
  });

  return {
    ruleVersion: PLANNING_RULE_VERSION,
    tieBreakRule: PLAN_TIE_BREAK_RULE,
    outcome,
    incomplete: outcome === 'INCOMPLETE',
    holdReasons,
    candidates: ordered,
    ranking,
    planHash,
  };
}
