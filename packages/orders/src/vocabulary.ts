// Pure order/job vocabulary and the observation planner (FR-13, INV-12). Purchase orders and service jobs are separate
// machines (@uptimebuyer/domain PURCHASE_ORDER / SERVICE_JOB); raw provider words are mapped PER KIND, so a provider
// using the same word for both cannot cross kinds. Providers can never report VERIFIED/DISPUTED (receiving inspection
// and work verification are operator outcomes) nor REQUESTED/UNKNOWN (UptimeBuyer's own states). The planner decides
// whether an observation applies, is stale/out of order, regresses the machine, or is unmapped, and classifies the
// material changes that reopen policy. It never decides payment state or recovery.
import { isTransitionAllowed } from '@uptimebuyer/domain';

export const ORDER_KINDS = Object.freeze(['PURCHASE_ORDER', 'SERVICE_JOB'] as const);
export type OrderKind = (typeof ORDER_KINDS)[number];
export type ObservationSource = 'WEBHOOK' | 'POLL' | 'BROKER' | 'OPERATOR';

export const RAW_STATUS_VOCABULARY: Readonly<Record<OrderKind, Readonly<Record<string, string>>>> = Object.freeze({
  PURCHASE_ORDER: Object.freeze({
    accepted: 'ACCEPTED',
    rejected: 'REJECTED',
    ordered: 'ORDERED',
    confirmed: 'ORDERED',
    partially_filled: 'PARTIALLY_FILLED',
    partial: 'PARTIALLY_FILLED',
    substitution_proposed: 'SUBSTITUTION_PROPOSED',
    substitute_offered: 'SUBSTITUTION_PROPOSED',
    change_review: 'CHANGE_REVIEW',
    backordered: 'CHANGE_REVIEW',
    out_of_stock: 'CHANGE_REVIEW',
    price_changed: 'CHANGE_REVIEW',
    quantity_changed: 'CHANGE_REVIEW',
    eta_changed: 'CHANGE_REVIEW',
    shipped: 'SHIPPED',
    in_transit: 'SHIPPED',
    delivered: 'DELIVERED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
    failed: 'FAILED',
  }),
  SERVICE_JOB: Object.freeze({
    accepted: 'ACCEPTED',
    rejected: 'REJECTED',
    scheduled: 'SCHEDULED',
    rescheduled: 'RESCHEDULED',
    en_route: 'EN_ROUTE',
    arrived: 'ARRIVED',
    on_site: 'ARRIVED',
    no_show: 'NO_SHOW',
    in_progress: 'IN_PROGRESS',
    scope_change_proposed: 'SCOPE_CHANGE_PROPOSED',
    work_complete: 'WORK_REPORTED_COMPLETE',
    completed: 'WORK_REPORTED_COMPLETE',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
    failed: 'FAILED',
  }),
});

/** Operator receiving-inspection / work-verification outcomes: the only path to VERIFIED and DISPUTED. */
export const OPERATOR_OUTCOMES = Object.freeze({ verified: 'VERIFIED', disputed: 'DISPUTED' } as const);

export const CHANGE_KINDS = Object.freeze([
  'PARTIAL_FILL',
  'SUBSTITUTION',
  'QUANTITY_CHANGE',
  'PRICE_CHANGE',
  'ETA_CHANGE',
  'STOCK_CHANGE',
  'RESCHEDULE',
  'NO_SHOW',
  'SCOPE_CHANGE',
  'CANCELLATION',
  'PROVIDER_FAILURE',
  'REJECTION',
  'DISPUTE',
  'REVOCATION',
] as const);
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Entering one of these blocks the next action, invalidates the plan and escalates the incident. */
export const MATERIAL_CHANGE_STATES: Readonly<Record<OrderKind, readonly string[]>> = Object.freeze({
  PURCHASE_ORDER: Object.freeze([
    'PARTIALLY_FILLED',
    'SUBSTITUTION_PROPOSED',
    'CHANGE_REVIEW',
    'CANCELLED',
    'FAILED',
    'REJECTED',
    'DISPUTED',
  ]),
  SERVICE_JOB: Object.freeze([
    'RESCHEDULED',
    'NO_SHOW',
    'SCOPE_CHANGE_PROPOSED',
    'CANCELLED',
    'FAILED',
    'REJECTED',
    'DISPUTED',
  ]),
});

/** Provider-reported completion: fulfillment/work evidence only, never recovery proof (INV-14). */
export const COMPLETION_REPORTED_STATES: Readonly<Record<OrderKind, readonly string[]>> = Object.freeze({
  PURCHASE_ORDER: Object.freeze(['DELIVERED', 'VERIFIED']),
  SERVICE_JOB: Object.freeze(['WORK_REPORTED_COMPLETE', 'VERIFIED']),
});

export const TERMINAL_STATES: Readonly<Record<OrderKind, readonly string[]>> = Object.freeze({
  PURCHASE_ORDER: Object.freeze(['VERIFIED', 'DISPUTED', 'REJECTED', 'CANCELLED', 'FAILED']),
  SERVICE_JOB: Object.freeze(['VERIFIED', 'DISPUTED', 'REJECTED', 'CANCELLED', 'FAILED', 'NO_SHOW']),
});

const STATE_CHANGE_KIND: Readonly<Record<string, ChangeKind>> = Object.freeze({
  PARTIALLY_FILLED: 'PARTIAL_FILL',
  SUBSTITUTION_PROPOSED: 'SUBSTITUTION',
  CHANGE_REVIEW: 'STOCK_CHANGE',
  RESCHEDULED: 'RESCHEDULE',
  NO_SHOW: 'NO_SHOW',
  SCOPE_CHANGE_PROPOSED: 'SCOPE_CHANGE',
  CANCELLED: 'CANCELLATION',
  FAILED: 'PROVIDER_FAILURE',
  REJECTED: 'REJECTION',
  DISPUTED: 'DISPUTE',
});
const RAW_CHANGE_KIND: Readonly<Record<string, ChangeKind>> = Object.freeze({
  price_changed: 'PRICE_CHANGE',
  quantity_changed: 'QUANTITY_CHANGE',
  eta_changed: 'ETA_CHANGE',
  backordered: 'STOCK_CHANGE',
  out_of_stock: 'STOCK_CHANGE',
});

/** Kinds that change the candidate itself go back through evidence, compatibility and approval; the rest re-plan. */
export function reentryFor(kind: ChangeKind): ('EVIDENCE' | 'COMPATIBILITY' | 'APPROVAL')[] {
  return ['CANCELLATION', 'PROVIDER_FAILURE', 'REJECTION', 'NO_SHOW', 'DISPUTE', 'REVOCATION'].includes(kind)
    ? ['APPROVAL']
    : ['EVIDENCE', 'COMPATIBILITY', 'APPROVAL'];
}

export const machineOf = (kind: OrderKind) => kind;

export function normalizeRawStatus(kind: OrderKind, raw: string): string | null {
  const v = RAW_STATUS_VOCABULARY[kind];
  return Object.hasOwn(v, raw) ? v[raw]! : null;
}

export interface ApprovedTerms {
  quantity: number;
  amountMinor: bigint;
  currency: string;
  etaAt: string | null;
}

/** Optional structured detail a provider may report beside its status word (all bounded by the ingress schema). */
export interface ObservationDetails {
  quantityFilled?: number;
  quantityConfirmed?: number;
  totalMinor?: string;
  currency?: string;
  etaAt?: string;
  scheduledStartAt?: string;
  substitutePartNumber?: string;
  substituteManufacturer?: string;
}

export interface ObservationInput {
  rawStatus: string;
  observedAt: string;
  sequence: number | null;
  details: ObservationDetails;
}

export type Disposition = 'APPLY' | 'STALE' | 'ILLEGAL' | 'UNMAPPED' | 'NO_CHANGE';

export interface ObservationPlan {
  disposition: Disposition;
  /** Normalized target state (the state actually entered when APPLY). */
  target: string | null;
  changeKind: ChangeKind | null;
  reasonCode: string | null;
}

/** A material difference between a routine provider update and the approved terms. */
function detailChange(kind: OrderKind, approved: ApprovedTerms, d: ObservationDetails): ChangeKind | null {
  if (kind === 'PURCHASE_ORDER' && d.quantityConfirmed !== undefined && d.quantityConfirmed !== approved.quantity)
    return 'QUANTITY_CHANGE';
  if (d.currency !== undefined && d.currency !== approved.currency) return 'PRICE_CHANGE';
  if (d.totalMinor !== undefined && /^\d{1,19}$/.test(d.totalMinor) && BigInt(d.totalMinor) > approved.amountMinor)
    return kind === 'SERVICE_JOB' ? 'SCOPE_CHANGE' : 'PRICE_CHANGE';
  const later = (x: string | undefined) =>
    x !== undefined && approved.etaAt !== null && Date.parse(x) > Date.parse(approved.etaAt);
  if (kind === 'PURCHASE_ORDER' && later(d.etaAt)) return 'ETA_CHANGE';
  if (kind === 'SERVICE_JOB' && (later(d.scheduledStartAt) || later(d.etaAt))) return 'RESCHEDULE';
  return null;
}

/** Where a detected detail change routes the order/job: the explicit review state of its machine. */
const CHANGE_STATE: Readonly<Record<OrderKind, Partial<Record<ChangeKind, string>>>> = Object.freeze({
  PURCHASE_ORDER: { QUANTITY_CHANGE: 'CHANGE_REVIEW', PRICE_CHANGE: 'CHANGE_REVIEW', ETA_CHANGE: 'CHANGE_REVIEW' },
  SERVICE_JOB: {
    RESCHEDULE: 'RESCHEDULED',
    SCOPE_CHANGE: 'SCOPE_CHANGE_PROPOSED',
    PRICE_CHANGE: 'SCOPE_CHANGE_PROPOSED',
  },
});

export function planObservation(input: {
  kind: OrderKind;
  current: string;
  approved: ApprovedTerms;
  lastObservedAt: string | null;
  lastSequence: number | null;
  source: ObservationSource;
  obs: ObservationInput;
}): ObservationPlan {
  const { kind, current, approved, obs } = input;
  const plan = (
    disposition: Disposition,
    target: string | null,
    changeKind: ChangeKind | null,
    reasonCode: string | null,
  ) => ({
    disposition,
    target,
    changeKind,
    reasonCode,
  });
  let normalized: string | null;
  if (input.source === 'OPERATOR')
    normalized = Object.hasOwn(OPERATOR_OUTCOMES, obs.rawStatus)
      ? OPERATOR_OUTCOMES[obs.rawStatus as keyof typeof OPERATOR_OUTCOMES]
      : null;
  else normalized = normalizeRawStatus(kind, obs.rawStatus);
  if (normalized === null) return plan('UNMAPPED', null, null, 'RAW_STATUS_UNMAPPED');
  if (input.lastObservedAt !== null && Date.parse(obs.observedAt) < Date.parse(input.lastObservedAt))
    return plan('STALE', normalized, null, 'OBSERVATION_OUT_OF_ORDER');
  if (obs.sequence !== null && input.lastSequence !== null && obs.sequence <= input.lastSequence)
    return plan('STALE', normalized, null, 'SEQUENCE_NOT_ADVANCING');

  let target = normalized;
  let changeKind: ChangeKind | null = RAW_CHANGE_KIND[obs.rawStatus] ?? null;
  const detail = input.source === 'OPERATOR' ? null : detailChange(kind, approved, obs.details);
  if (detail !== null && !MATERIAL_CHANGE_STATES[kind].includes(normalized)) {
    const review = CHANGE_STATE[kind][detail];
    if (review && isTransitionAllowed(kind, current, review)) target = review;
    changeKind = detail;
  }
  if (target === current && !isTransitionAllowed(kind, current, target))
    return plan('NO_CHANGE', target, null, 'STATE_UNCHANGED');
  if (!isTransitionAllowed(kind, current, target)) return plan('ILLEGAL', target, null, 'STATE_TRANSITION_INVALID');
  if (changeKind === null) changeKind = STATE_CHANGE_KIND[target] ?? null;
  if (changeKind !== null && !MATERIAL_CHANGE_STATES[kind].includes(target) && detail === null) changeKind = null;
  return plan('APPLY', target, changeKind, null);
}
