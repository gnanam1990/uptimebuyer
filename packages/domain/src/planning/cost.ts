// Cost-to-recovery computation (FR-09, TDD §9, M08). Pure and fail-closed:
//
//   expected_cost = purchase_or_service_minor
//                 + expected_delay_ms * downtime_cost_minor_per_hour / 3_600_000
//                 + versioned_tenant_risk_ppm * inventory_value_minor / 1_000_000
//                 + repeat_failure_probability_ppm * repeat_failure_cost_minor / 1_000_000
//
// Units: money in integer minor units of one ISO currency (no conversion), delay in integer milliseconds, rates in
// minor units per hour, probabilities in integer parts per million (0..1_000_000) with low <= estimate <= high.
// Every intermediate is an exact rational over the common denominator 3_600_000 * 1_000_000; the final sum is
// rounded half-up (ties away from zero) exactly once to the minor unit, so a tiny per-millisecond rate never
// truncates to zero. The tenant risk estimate is deadline-conditioned: the incident's projected containment deadline
// (`current_response_deadline_at`, never an SOP or model) selects the within- or past-deadline inventory-loss
// probability. A missing or invalid mandatory input yields an explicit incomplete result with no total — never a
// zero or default.
import { INT64_MAX, ISO_4217_MINOR_UNITS, roundHalfUp, type CurrencyCode } from '@uptimebuyer/contracts';

export const PLANNING_RULE_VERSION = 'cost-to-recovery.r1';
export const MS_PER_HOUR = 3_600_000n;
export const PPM_DENOMINATOR = 1_000_000n;
/** Common denominator of every component: 3_600_000 * 1_000_000. */
export const COST_DENOMINATOR = MS_PER_HOUR * PPM_DENOMINATOR;
/** Longest expected delay the planner prices (90 days); beyond it the input is out of bounds, not clamped. */
export const MAX_EXPECTED_DELAY_MS = 90 * 86_400_000;

export const PROVENANCE_SOURCES = Object.freeze([
  'CANDIDATE_ACTION',
  'PROVIDER_QUOTE',
  'TENANT_RISK_ESTIMATE',
  'REGISTRY_FOOD_AT_RISK',
  'INCIDENT_DEADLINE_PROJECTION',
  'COMPATIBILITY_DECISION',
] as const);
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** Where an input came from: the source record, its revision (null when the source is unrevisioned) and as-of time. */
export interface Provenance {
  readonly source: ProvenanceSource;
  readonly ref: string;
  readonly revision: number | null;
  readonly asOf: string;
}
export interface MoneyInput {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly provenance: Provenance;
}
export interface PpmInput {
  readonly estimatePpm: number;
  readonly lowPpm: number;
  readonly highPpm: number;
  readonly provenance: Provenance;
}
export interface DelayInput {
  readonly ms: number;
  readonly provenance: Provenance;
}
export const DEADLINE_STATUSES = Object.freeze(['RUNNING', 'PAUSED', 'EXPIRED'] as const);
/** The incident's projected deadline: `current_response_deadline_at` plus the latest deadline event sequence. */
export interface DeadlineInput {
  readonly currentResponseDeadlineAt: string;
  readonly status: (typeof DEADLINE_STATUSES)[number];
  readonly eventSequence: number;
  readonly procedureRevisionId: string;
  readonly provenance: Provenance;
}

export interface CostInputs {
  /** The plan currency (from the versioned tenant risk estimate); null only when that estimate is missing. */
  readonly currency: CurrencyCode | null;
  readonly purchaseOrService: MoneyInput | null;
  readonly expectedDelay: DelayInput | null;
  readonly downtimeCostPerHour: MoneyInput | null;
  readonly inventoryLossWithinDeadline: PpmInput | null;
  readonly inventoryLossPastDeadline: PpmInput | null;
  readonly inventoryValue: MoneyInput | null;
  readonly repeatFailureProbability: PpmInput | null;
  readonly repeatFailureCost: MoneyInput | null;
}
export interface CostContext {
  readonly evaluatedAt: string;
  readonly deadline: DeadlineInput | null;
}

export const ISSUE_REASONS = Object.freeze([
  'MISSING',
  'INVALID',
  'OUT_OF_BOUNDS',
  'CURRENCY_MISMATCH',
  'STALE',
  'MISMATCH',
] as const);
export type IssueReason = (typeof ISSUE_REASONS)[number];
export interface InputIssue {
  readonly field: string;
  readonly reason: IssueReason;
  readonly detail?: string;
}

export interface ExactRational {
  readonly num: bigint;
  readonly den: bigint;
}
export type ComponentKey = 'PURCHASE_OR_SERVICE' | 'DELAY_DOWNTIME' | 'INVENTORY_RISK' | 'REPEAT_FAILURE';
export interface CostComponent {
  readonly key: ComponentKey;
  readonly formula: string;
  readonly unit: 'MINOR_UNITS';
  /** Exact value in minor units, reduced. */
  readonly exact: ExactRational;
  /** Display-only rounding of this component; the total is never the sum of these. */
  readonly displayMinor: bigint;
}
export type InputUnit = 'MINOR_UNITS' | 'MINOR_UNITS_PER_HOUR' | 'MILLISECONDS' | 'PPM' | 'UTC_INSTANT';
export interface ExposedInput {
  readonly field: string;
  readonly value: string | null;
  readonly unit: InputUnit;
  readonly currency: CurrencyCode | null;
  readonly status: 'PRESENT' | 'MISSING' | 'INVALID';
  readonly provenance: Provenance | null;
  readonly uncertainty: { readonly low: string; readonly high: string } | null;
}
export type DeadlineFit = 'WITHIN_DEADLINE' | 'MISSES_DEADLINE' | 'DEADLINE_PASSED';

export interface CostResult {
  readonly ruleVersion: string;
  readonly complete: boolean;
  readonly issues: InputIssue[];
  readonly inputs: ExposedInput[];
  readonly currency: CurrencyCode | null;
  readonly expectedCostMinor: bigint | null;
  readonly exactTotal: ExactRational | null;
  readonly components: CostComponent[];
  /** Expected cost at the low and high uncertainty bounds of every bounded input (each rounded once). */
  readonly range: { readonly lowMinor: bigint; readonly highMinor: bigint } | null;
  /** Extra expected cost if the recovery missed the projected deadline (sensitivity; rounded once). */
  readonly deadlinePenaltyMinor: bigint | null;
  readonly deadlineFit: DeadlineFit | null;
  readonly recoveryEtaAt: string | null;
}

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const isUtcInstant = (v: unknown): v is string =>
  typeof v === 'string' && UTC_RE.test(v) && !Number.isNaN(Date.parse(v));

const isCurrency = (v: unknown): v is CurrencyCode => typeof v === 'string' && Object.hasOwn(ISO_4217_MINOR_UNITS, v);

function provenanceOk(p: unknown): p is Provenance {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    (PROVENANCE_SOURCES as readonly unknown[]).includes(o.source) &&
    typeof o.ref === 'string' &&
    o.ref.length > 0 &&
    o.ref.length <= 128 &&
    (o.revision === null || (Number.isSafeInteger(o.revision) && (o.revision as number) >= 1)) &&
    isUtcInstant(o.asOf)
  );
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}
const reduce = (num: bigint, den: bigint): ExactRational => {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
};

type Checked<T> = { ok: true; value: T } | { ok: false; issue: InputIssue | null };

function checkMoney(field: string, v: MoneyInput | null, currency: CurrencyCode | null): Checked<MoneyInput> {
  if (v === null || v === undefined) return { ok: false, issue: { field, reason: 'MISSING' } };
  if (typeof v.amountMinor !== 'bigint' || !isCurrency(v.currency) || !provenanceOk(v.provenance))
    return { ok: false, issue: { field, reason: 'INVALID' } };
  if (v.amountMinor < 0n) return { ok: false, issue: { field, reason: 'INVALID' } };
  if (v.amountMinor > INT64_MAX) return { ok: false, issue: { field, reason: 'OUT_OF_BOUNDS' } };
  if (currency !== null && v.currency !== currency) return { ok: false, issue: { field, reason: 'CURRENCY_MISMATCH' } };
  return { ok: true, value: v };
}

function checkPpm(field: string, v: PpmInput | null): Checked<PpmInput> {
  if (v === null || v === undefined) return { ok: false, issue: { field, reason: 'MISSING' } };
  const ints = [v.estimatePpm, v.lowPpm, v.highPpm];
  if (!ints.every((n) => Number.isSafeInteger(n)) || !provenanceOk(v.provenance))
    return { ok: false, issue: { field, reason: 'INVALID' } };
  if (ints.some((n) => n < 0 || n > 1_000_000)) return { ok: false, issue: { field, reason: 'OUT_OF_BOUNDS' } };
  if (!(v.lowPpm <= v.estimatePpm && v.estimatePpm <= v.highPpm))
    return { ok: false, issue: { field, reason: 'INVALID' } };
  return { ok: true, value: v };
}

function checkDelay(field: string, v: DelayInput | null): Checked<DelayInput> {
  if (v === null || v === undefined) return { ok: false, issue: { field, reason: 'MISSING' } };
  if (!Number.isSafeInteger(v.ms) || v.ms < 0 || !provenanceOk(v.provenance))
    return { ok: false, issue: { field, reason: 'INVALID' } };
  if (v.ms > MAX_EXPECTED_DELAY_MS) return { ok: false, issue: { field, reason: 'OUT_OF_BOUNDS' } };
  return { ok: true, value: v };
}

function checkDeadline(v: DeadlineInput | null): Checked<DeadlineInput> {
  const field = 'deadline';
  if (v === null || v === undefined) return { ok: false, issue: { field, reason: 'MISSING' } };
  if (
    !isUtcInstant(v.currentResponseDeadlineAt) ||
    !(DEADLINE_STATUSES as readonly string[]).includes(v.status) ||
    !Number.isSafeInteger(v.eventSequence) ||
    v.eventSequence < 1 ||
    typeof v.procedureRevisionId !== 'string' ||
    v.procedureRevisionId.length === 0 ||
    !provenanceOk(v.provenance)
  )
    return { ok: false, issue: { field, reason: 'INVALID' } };
  return { ok: true, value: v };
}

const str = (v: unknown): string | null =>
  typeof v === 'bigint' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null;

function exposeMoney(field: string, unit: InputUnit, v: MoneyInput | null, c: Checked<MoneyInput>): ExposedInput {
  return {
    field,
    value: v ? str(v.amountMinor) : null,
    unit,
    currency: v && isCurrency(v.currency) ? v.currency : null,
    status: c.ok ? 'PRESENT' : c.issue?.reason === 'MISSING' ? 'MISSING' : 'INVALID',
    provenance: v && provenanceOk(v.provenance) ? v.provenance : null,
    uncertainty: null,
  };
}
function exposePpm(field: string, v: PpmInput | null, c: Checked<PpmInput>): ExposedInput {
  return {
    field,
    value: v ? str(v.estimatePpm) : null,
    unit: 'PPM',
    currency: null,
    status: c.ok ? 'PRESENT' : c.issue?.reason === 'MISSING' ? 'MISSING' : 'INVALID',
    provenance: v && provenanceOk(v.provenance) ? v.provenance : null,
    uncertainty:
      v && str(v.lowPpm) !== null && str(v.highPpm) !== null ? { low: str(v.lowPpm)!, high: str(v.highPpm)! } : null,
  };
}

const FORMULAS: Record<ComponentKey, string> = {
  PURCHASE_OR_SERVICE: 'purchase_or_service_minor',
  DELAY_DOWNTIME: 'expected_delay_ms * downtime_cost_minor_per_hour / 3_600_000',
  INVENTORY_RISK: 'versioned_tenant_risk_ppm(deadline_fit) * inventory_value_minor / 1_000_000',
  REPEAT_FAILURE: 'repeat_failure_probability_ppm * repeat_failure_cost_minor / 1_000_000',
};

function fitFor(evaluatedAtMs: number, delayMs: number, deadline: DeadlineInput): DeadlineFit {
  const deadlineMs = Date.parse(deadline.currentResponseDeadlineAt);
  if (deadline.status === 'EXPIRED' || deadlineMs <= evaluatedAtMs) return 'DEADLINE_PASSED';
  return evaluatedAtMs + delayMs <= deadlineMs ? 'WITHIN_DEADLINE' : 'MISSES_DEADLINE';
}

/** Numerators over COST_DENOMINATOR for each component. */
function numerators(
  p: bigint,
  delayMs: number,
  rate: bigint,
  riskPpm: number,
  inv: bigint,
  repPpm: number,
  repCost: bigint,
) {
  return {
    PURCHASE_OR_SERVICE: p * COST_DENOMINATOR,
    DELAY_DOWNTIME: BigInt(delayMs) * rate * PPM_DENOMINATOR,
    INVENTORY_RISK: BigInt(riskPpm) * inv * MS_PER_HOUR,
    REPEAT_FAILURE: BigInt(repPpm) * repCost * MS_PER_HOUR,
  } satisfies Record<ComponentKey, bigint>;
}
const total = (n: Record<ComponentKey, bigint>) =>
  n.PURCHASE_OR_SERVICE + n.DELAY_DOWNTIME + n.INVENTORY_RISK + n.REPEAT_FAILURE;

export function computeCostToRecovery(inputs: CostInputs, ctx: CostContext): CostResult {
  const currency = isCurrency(inputs.currency) ? inputs.currency : null;
  const purchase = checkMoney('purchaseOrService', inputs.purchaseOrService, currency);
  const delay = checkDelay('expectedDelay', inputs.expectedDelay);
  const rate = checkMoney('downtimeCostPerHour', inputs.downtimeCostPerHour, currency);
  const within = checkPpm('inventoryLossWithinDeadline', inputs.inventoryLossWithinDeadline);
  const past = checkPpm('inventoryLossPastDeadline', inputs.inventoryLossPastDeadline);
  const inventory = checkMoney('inventoryValue', inputs.inventoryValue, currency);
  const repeatP = checkPpm('repeatFailureProbability', inputs.repeatFailureProbability);
  const repeatCost = checkMoney('repeatFailureCost', inputs.repeatFailureCost, currency);
  const deadline = checkDeadline(ctx.deadline);
  const evaluatedOk = isUtcInstant(ctx.evaluatedAt);

  const d = inputs.expectedDelay;
  const exposedInputs: ExposedInput[] = [
    exposeMoney('purchaseOrService', 'MINOR_UNITS', inputs.purchaseOrService, purchase),
    {
      field: 'expectedDelay',
      value: d ? str(d.ms) : null,
      unit: 'MILLISECONDS',
      currency: null,
      status: delay.ok ? 'PRESENT' : delay.issue?.reason === 'MISSING' ? 'MISSING' : 'INVALID',
      provenance: d && provenanceOk(d.provenance) ? d.provenance : null,
      uncertainty: null,
    },
    exposeMoney('downtimeCostPerHour', 'MINOR_UNITS_PER_HOUR', inputs.downtimeCostPerHour, rate),
    exposePpm('inventoryLossWithinDeadline', inputs.inventoryLossWithinDeadline, within),
    exposePpm('inventoryLossPastDeadline', inputs.inventoryLossPastDeadline, past),
    exposeMoney('inventoryValue', 'MINOR_UNITS', inputs.inventoryValue, inventory),
    exposePpm('repeatFailureProbability', inputs.repeatFailureProbability, repeatP),
    exposeMoney('repeatFailureCost', 'MINOR_UNITS', inputs.repeatFailureCost, repeatCost),
    {
      field: 'deadline',
      value:
        ctx.deadline && isUtcInstant(ctx.deadline.currentResponseDeadlineAt)
          ? ctx.deadline.currentResponseDeadlineAt
          : null,
      unit: 'UTC_INSTANT',
      currency: null,
      status: deadline.ok ? 'PRESENT' : deadline.issue?.reason === 'MISSING' ? 'MISSING' : 'INVALID',
      provenance: ctx.deadline && provenanceOk(ctx.deadline.provenance) ? ctx.deadline.provenance : null,
      uncertainty: null,
    },
  ];

  const issues: InputIssue[] = [];
  for (const c of [purchase, delay, rate, within, past, inventory, repeatP, repeatCost, deadline])
    if (!c.ok && c.issue) issues.push(c.issue);
  if (!evaluatedOk) issues.push({ field: 'evaluatedAt', reason: 'INVALID' });

  const incomplete = (extra: InputIssue[] = []): CostResult => ({
    ruleVersion: PLANNING_RULE_VERSION,
    complete: false,
    issues: [...issues, ...extra],
    inputs: exposedInputs,
    currency,
    expectedCostMinor: null,
    exactTotal: null,
    components: [],
    range: null,
    deadlinePenaltyMinor: null,
    deadlineFit: null,
    recoveryEtaAt: null,
  });
  if (
    issues.length > 0 ||
    !purchase.ok ||
    !delay.ok ||
    !rate.ok ||
    !within.ok ||
    !past.ok ||
    !inventory.ok ||
    !repeatP.ok ||
    !repeatCost.ok ||
    !deadline.ok
  )
    return incomplete();

  const evaluatedAtMs = Date.parse(ctx.evaluatedAt);
  const priced = (delayMs: number, pick: 'estimatePpm' | 'lowPpm' | 'highPpm', fit: DeadlineFit) =>
    numerators(
      purchase.value.amountMinor,
      delayMs,
      rate.value.amountMinor,
      (fit === 'WITHIN_DEADLINE' ? within.value : past.value)[pick],
      inventory.value.amountMinor,
      repeatP.value[pick],
      repeatCost.value.amountMinor,
    );
  const delayMs = delay.value.ms;
  const fit = fitFor(evaluatedAtMs, delayMs, deadline.value);
  const nums = priced(delayMs, 'estimatePpm', fit);
  const exactNum = total(nums);
  const expected = roundHalfUp(exactNum, COST_DENOMINATOR);
  const low = roundHalfUp(total(priced(delayMs, 'lowPpm', fit)), COST_DENOMINATOR);
  const high = roundHalfUp(total(priced(delayMs, 'highPpm', fit)), COST_DENOMINATOR);
  const penaltyNum =
    BigInt(past.value.estimatePpm - within.value.estimatePpm) * inventory.value.amountMinor * MS_PER_HOUR;
  const penalty = roundHalfUp(penaltyNum, COST_DENOMINATOR);
  if (expected > INT64_MAX || high > INT64_MAX) return incomplete([{ field: 'expectedCost', reason: 'OUT_OF_BOUNDS' }]);

  const components: CostComponent[] = (Object.keys(FORMULAS) as ComponentKey[]).map((key) => ({
    key,
    formula: FORMULAS[key],
    unit: 'MINOR_UNITS',
    exact: reduce(nums[key], COST_DENOMINATOR),
    displayMinor: roundHalfUp(nums[key], COST_DENOMINATOR),
  }));
  return {
    ruleVersion: PLANNING_RULE_VERSION,
    complete: true,
    issues: [],
    inputs: exposedInputs,
    currency,
    expectedCostMinor: expected,
    exactTotal: reduce(exactNum, COST_DENOMINATOR),
    components,
    range: { lowMinor: low, highMinor: high },
    deadlinePenaltyMinor: penalty,
    deadlineFit: fit,
    recoveryEtaAt: new Date(evaluatedAtMs + delayMs).toISOString(),
  };
}
