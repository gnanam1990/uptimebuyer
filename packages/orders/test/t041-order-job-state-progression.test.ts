// T-041 — Order and job state progression (unit layer). Table-driven over every allowed and denied pair of the SEPARATE
// purchase-order and service-job machines, transcribed here independently from docs/spec/STATE-MACHINES.md §8/§9 and
// compared with the canonical domain tables. Then the M10 observation planner: each named purchase state (requested,
// accepted, ordered, partial fill, substitution proposal, quantity/price/ETA/stock change review, shipped, delivered,
// verified, rejected, cancelled, failed, unknown) and service state (requested, accepted, scheduled, rescheduled,
// en route, arrived, no-show, in progress, scope-change proposal, work reported complete, verified/disputed, rejected,
// cancelled, failed, unknown) is reached only by a legal edge; regressions, stale/out-of-order observations and
// cross-kind raw words are refused; provider words can never claim VERIFIED/DISPUTED; material changes are classified.
import { describe, expect, it } from 'vitest';
import { PURCHASE_ORDER_STATES, SERVICE_JOB_STATES } from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import {
  COMPLETION_REPORTED_STATES,
  MATERIAL_CHANGE_STATES,
  RAW_STATUS_VOCABULARY,
  normalizeRawStatus,
  planObservation,
  type ApprovedTerms,
  type OrderKind,
} from '../src/index.js';

const PURCHASE: Record<string, string[]> = {
  REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['ACCEPTED', 'REJECTED', 'ORDERED', 'PARTIALLY_FILLED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED'],
  ACCEPTED: ['ORDERED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  ORDERED: ['PARTIALLY_FILLED', 'SHIPPED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  PARTIALLY_FILLED: [
    'SHIPPED',
    'DELIVERED',
    'SUBSTITUTION_PROPOSED',
    'CHANGE_REVIEW',
    'CANCELLED',
    'FAILED',
    'UNKNOWN',
  ],
  SHIPPED: ['DELIVERED', 'PARTIALLY_FILLED', 'CHANGE_REVIEW', 'FAILED', 'UNKNOWN'],
  DELIVERED: ['VERIFIED', 'DISPUTED'],
  SUBSTITUTION_PROPOSED: ['CANCELLED'],
  CHANGE_REVIEW: ['CANCELLED'],
};
const SERVICE: Record<string, string[]> = {
  REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: [
    'ACCEPTED',
    'REJECTED',
    'SCHEDULED',
    'RESCHEDULED',
    'NO_SHOW',
    'EN_ROUTE',
    'ARRIVED',
    'IN_PROGRESS',
    'WORK_REPORTED_COMPLETE',
    'CANCELLED',
    'FAILED',
  ],
  ACCEPTED: ['SCHEDULED', 'RESCHEDULED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  SCHEDULED: ['SCHEDULED', 'EN_ROUTE', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  RESCHEDULED: ['SCHEDULED', 'EN_ROUTE', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  EN_ROUTE: ['ARRIVED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  ARRIVED: ['IN_PROGRESS', 'SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'FAILED'],
  IN_PROGRESS: ['WORK_REPORTED_COMPLETE', 'SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
  WORK_REPORTED_COMPLETE: ['VERIFIED', 'DISPUTED'],
  SCOPE_CHANGE_PROPOSED: ['CANCELLED'],
};

const approved: ApprovedTerms = {
  quantity: 2,
  amountMinor: 18_500n,
  currency: 'USD',
  etaAt: '2026-11-10T12:00:00.000Z',
};
let clock = Date.parse('2026-11-05T09:00:00.000Z');
const at = () => new Date((clock += 60_000)).toISOString();

function step(
  kind: OrderKind,
  current: string,
  rawStatus: string,
  extra: Partial<Parameters<typeof planObservation>[0]> = {},
) {
  return planObservation({
    kind,
    current,
    approved,
    lastObservedAt: null,
    lastSequence: null,
    source: 'WEBHOOK',
    obs: { rawStatus, observedAt: at(), sequence: null, details: {} },
    ...extra,
  });
}

/** Walk a raw-status script from REQUESTED and return every state passed through. */
function walk(kind: OrderKind, script: string[], source: 'WEBHOOK' | 'OPERATOR' = 'WEBHOOK') {
  let s = 'REQUESTED';
  const seen = [s];
  for (const raw of script) {
    const p = step(kind, s, raw, { source: raw === 'verified' || raw === 'disputed' ? 'OPERATOR' : source });
    expect(p.disposition, `${kind} ${s} + ${raw}`).toBe('APPLY');
    s = p.target!;
    seen.push(s);
  }
  return seen;
}

describe('T-041 order and job state progression (separate machines, every pair)', () => {
  for (const [kind, table, states] of [
    ['PURCHASE_ORDER', PURCHASE, PURCHASE_ORDER_STATES],
    ['SERVICE_JOB', SERVICE, SERVICE_JOB_STATES],
  ] as const)
    it(`${kind}: the domain machine allows exactly the specified edges`, () => {
      const mismatches: string[] = [];
      for (const from of states)
        for (const to of states) {
          const expected = (table[from] ?? []).includes(to);
          if (isTransitionAllowed(kind, from, to) !== expected) mismatches.push(`${from}->${to}`);
        }
      expect(mismatches).toEqual([]);
    });

  it('cross-kind: no purchase state name is accepted by the service machine where it differs, and vice versa', () => {
    expect(isTransitionAllowed('SERVICE_JOB', 'ACCEPTED', 'ORDERED')).toBe(false);
    expect(isTransitionAllowed('SERVICE_JOB', 'IN_PROGRESS', 'DELIVERED')).toBe(false);
    expect(isTransitionAllowed('PURCHASE_ORDER', 'ACCEPTED', 'SCHEDULED')).toBe(false);
    expect(isTransitionAllowed('PURCHASE_ORDER', 'SHIPPED', 'WORK_REPORTED_COMPLETE')).toBe(false);
  });
});

describe('T-041 raw provider vocabulary is per kind and cannot claim verification', () => {
  it('every raw word maps into its own machine and never to REQUESTED, UNKNOWN, VERIFIED or DISPUTED', () => {
    for (const kind of ['PURCHASE_ORDER', 'SERVICE_JOB'] as const) {
      const states: readonly string[] = kind === 'PURCHASE_ORDER' ? PURCHASE_ORDER_STATES : SERVICE_JOB_STATES;
      for (const [raw, state] of Object.entries(RAW_STATUS_VOCABULARY[kind])) {
        expect(states, `${kind}:${raw}`).toContain(state);
        expect(['REQUESTED', 'UNKNOWN', 'VERIFIED', 'DISPUTED']).not.toContain(state);
      }
    }
  });

  it('a raw word of the other kind is unmapped even when the provider uses the same vocabulary', () => {
    expect(normalizeRawStatus('PURCHASE_ORDER', 'scheduled')).toBeNull();
    expect(normalizeRawStatus('PURCHASE_ORDER', 'arrived')).toBeNull();
    expect(normalizeRawStatus('SERVICE_JOB', 'shipped')).toBeNull();
    expect(normalizeRawStatus('SERVICE_JOB', 'partially_filled')).toBeNull();
    expect(step('PURCHASE_ORDER', 'ACCEPTED', 'scheduled').disposition).toBe('UNMAPPED');
    expect(step('SERVICE_JOB', 'ACCEPTED', 'shipped').disposition).toBe('UNMAPPED');
  });

  it('a provider cannot report verified/disputed; only an operator outcome can', () => {
    expect(step('PURCHASE_ORDER', 'DELIVERED', 'verified').disposition).toBe('UNMAPPED');
    expect(step('SERVICE_JOB', 'WORK_REPORTED_COMPLETE', 'verified', { source: 'POLL' }).disposition).toBe('UNMAPPED');
    expect(step('PURCHASE_ORDER', 'DELIVERED', 'verified', { source: 'OPERATOR' }).target).toBe('VERIFIED');
    expect(step('SERVICE_JOB', 'WORK_REPORTED_COMPLETE', 'disputed', { source: 'OPERATOR' }).target).toBe('DISPUTED');
    // An operator cannot jump a purchase order to VERIFIED before delivery.
    expect(step('PURCHASE_ORDER', 'SHIPPED', 'verified', { source: 'OPERATOR' }).disposition).toBe('ILLEGAL');
  });
});

describe('T-041 purchase progression proves every named purchase state', () => {
  it('requested -> accepted -> ordered -> shipped -> delivered -> verified (completion is not material)', () => {
    expect(walk('PURCHASE_ORDER', ['accepted', 'ordered', 'shipped', 'delivered', 'verified'])).toEqual([
      'REQUESTED',
      'ACCEPTED',
      'ORDERED',
      'SHIPPED',
      'DELIVERED',
      'VERIFIED',
    ]);
    expect(COMPLETION_REPORTED_STATES.PURCHASE_ORDER).toContain('DELIVERED');
    expect(step('PURCHASE_ORDER', 'SHIPPED', 'delivered').changeKind).toBeNull();
  });

  it('partial fill, substitution proposal and change review are explicit material states', () => {
    const pf = step('PURCHASE_ORDER', 'ORDERED', 'partially_filled', {
      obs: { rawStatus: 'partially_filled', observedAt: at(), sequence: null, details: { quantityFilled: 1 } },
    });
    expect([pf.target, pf.changeKind]).toEqual(['PARTIALLY_FILLED', 'PARTIAL_FILL']);
    const sub = step('PURCHASE_ORDER', 'ACCEPTED', 'substitution_proposed', {
      obs: {
        rawStatus: 'substitution_proposed',
        observedAt: at(),
        sequence: null,
        details: { substitutePartNumber: '5A1-0499', substituteManufacturer: 'Northwind' },
      },
    });
    expect([sub.target, sub.changeKind]).toEqual(['SUBSTITUTION_PROPOSED', 'SUBSTITUTION']);
    for (const [raw, kind] of [
      ['backordered', 'STOCK_CHANGE'],
      ['out_of_stock', 'STOCK_CHANGE'],
      ['price_changed', 'PRICE_CHANGE'],
      ['quantity_changed', 'QUANTITY_CHANGE'],
      ['eta_changed', 'ETA_CHANGE'],
    ] as const)
      expect([
        step('PURCHASE_ORDER', 'ORDERED', raw).target,
        step('PURCHASE_ORDER', 'ORDERED', raw).changeKind,
      ]).toEqual(['CHANGE_REVIEW', kind]);
    for (const s of ['PARTIALLY_FILLED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'REJECTED'])
      expect(MATERIAL_CHANGE_STATES.PURCHASE_ORDER).toContain(s);
  });

  it('a material quantity, price or ETA difference in an otherwise routine update is routed to CHANGE_REVIEW', () => {
    const obs = (details: Record<string, unknown>) => ({
      rawStatus: 'ordered',
      observedAt: at(),
      sequence: null,
      details,
    });
    const q = step('PURCHASE_ORDER', 'ACCEPTED', 'ordered', { obs: obs({ quantityConfirmed: 1 }) });
    expect([q.target, q.changeKind]).toEqual(['CHANGE_REVIEW', 'QUANTITY_CHANGE']);
    const p = step('PURCHASE_ORDER', 'ACCEPTED', 'ordered', { obs: obs({ totalMinor: '19000', currency: 'USD' }) });
    expect([p.target, p.changeKind]).toEqual(['CHANGE_REVIEW', 'PRICE_CHANGE']);
    const c = step('PURCHASE_ORDER', 'ACCEPTED', 'ordered', { obs: obs({ totalMinor: '18500', currency: 'EUR' }) });
    expect([c.target, c.changeKind]).toEqual(['CHANGE_REVIEW', 'PRICE_CHANGE']);
    const e = step('PURCHASE_ORDER', 'ORDERED', 'shipped', {
      obs: { ...obs({ etaAt: '2026-11-12T12:00:00.000Z' }), rawStatus: 'shipped' },
    });
    expect([e.target, e.changeKind]).toEqual(['CHANGE_REVIEW', 'ETA_CHANGE']);
    // Equal or better terms are not material.
    const ok = step('PURCHASE_ORDER', 'ACCEPTED', 'ordered', {
      obs: obs({ quantityConfirmed: 2, totalMinor: '18000', currency: 'USD', etaAt: '2026-11-09T12:00:00.000Z' }),
    });
    expect([ok.target, ok.changeKind]).toEqual(['ORDERED', null]);
  });

  it('rejected, cancelled, failed and unknown are reachable; UNKNOWN leaves only to reconciled states', () => {
    expect(step('PURCHASE_ORDER', 'REQUESTED', 'rejected').target).toBe('REJECTED');
    expect(step('PURCHASE_ORDER', 'ORDERED', 'cancelled').changeKind).toBe('CANCELLATION');
    expect(step('PURCHASE_ORDER', 'SHIPPED', 'failed').changeKind).toBe('PROVIDER_FAILURE');
    expect(step('PURCHASE_ORDER', 'REQUESTED', 'rejected').changeKind).toBe('REJECTION');
    expect(step('PURCHASE_ORDER', 'UNKNOWN', 'shipped').target).toBe('SHIPPED');
    expect(step('PURCHASE_ORDER', 'UNKNOWN', 'substitution_proposed').disposition).toBe('ILLEGAL');
  });

  it('regression, terminal re-entry and out-of-order observations are refused', () => {
    expect(step('PURCHASE_ORDER', 'DELIVERED', 'shipped').disposition).toBe('ILLEGAL');
    expect(step('PURCHASE_ORDER', 'SHIPPED', 'ordered').disposition).toBe('ILLEGAL');
    expect(step('PURCHASE_ORDER', 'CANCELLED', 'shipped').disposition).toBe('ILLEGAL');
    expect(step('PURCHASE_ORDER', 'SUBSTITUTION_PROPOSED', 'ordered').disposition).toBe('ILLEGAL');
    const late = planObservation({
      kind: 'PURCHASE_ORDER',
      current: 'SHIPPED',
      approved,
      lastObservedAt: '2026-11-06T10:00:00.000Z',
      lastSequence: null,
      source: 'WEBHOOK',
      obs: { rawStatus: 'partially_filled', observedAt: '2026-11-06T09:00:00.000Z', sequence: null, details: {} },
    });
    expect(late.disposition).toBe('STALE');
    const seq = planObservation({
      kind: 'PURCHASE_ORDER',
      current: 'ORDERED',
      approved,
      lastObservedAt: null,
      lastSequence: 7,
      source: 'POLL',
      obs: { rawStatus: 'shipped', observedAt: at(), sequence: 7, details: {} },
    });
    expect(seq.disposition).toBe('STALE');
    expect(step('PURCHASE_ORDER', 'ORDERED', 'ordered').disposition).toBe('NO_CHANGE');
  });
});

describe('T-041 service progression proves every named service state', () => {
  it('requested -> accepted -> scheduled -> en route -> arrived -> in progress -> work reported complete -> verified', () => {
    expect(
      walk('SERVICE_JOB', ['accepted', 'scheduled', 'en_route', 'arrived', 'in_progress', 'work_complete', 'verified']),
    ).toEqual([
      'REQUESTED',
      'ACCEPTED',
      'SCHEDULED',
      'EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
      'WORK_REPORTED_COMPLETE',
      'VERIFIED',
    ]);
    expect(COMPLETION_REPORTED_STATES.SERVICE_JOB).toContain('WORK_REPORTED_COMPLETE');
    expect(step('SERVICE_JOB', 'IN_PROGRESS', 'work_complete').changeKind).toBeNull();
  });

  it('reschedule (including the literal self-edge), no-show and scope change are explicit material states', () => {
    expect([
      step('SERVICE_JOB', 'SCHEDULED', 'rescheduled').target,
      step('SERVICE_JOB', 'SCHEDULED', 'rescheduled').changeKind,
    ]).toEqual(['RESCHEDULED', 'RESCHEDULE']);
    expect(step('SERVICE_JOB', 'RESCHEDULED', 'rescheduled').disposition).toBe('APPLY');
    expect(step('SERVICE_JOB', 'EN_ROUTE', 'no_show').changeKind).toBe('NO_SHOW');
    expect(step('SERVICE_JOB', 'IN_PROGRESS', 'scope_change_proposed').changeKind).toBe('SCOPE_CHANGE');
    // A first schedule later than the approved arrival is a material reschedule, not a routine schedule.
    const late = step('SERVICE_JOB', 'ACCEPTED', 'scheduled', {
      obs: {
        rawStatus: 'scheduled',
        observedAt: at(),
        sequence: null,
        details: { scheduledStartAt: '2026-11-11T08:00:00.000Z' },
      },
    });
    expect([late.target, late.changeKind]).toEqual(['RESCHEDULED', 'RESCHEDULE']);
    for (const s of ['RESCHEDULED', 'NO_SHOW', 'SCOPE_CHANGE_PROPOSED', 'CANCELLED', 'FAILED', 'REJECTED'])
      expect(MATERIAL_CHANGE_STATES.SERVICE_JOB).toContain(s);
  });

  it('disputed, rejected, cancelled, failed and unknown; arrival cannot become unknown; regressions refused', () => {
    expect(step('SERVICE_JOB', 'WORK_REPORTED_COMPLETE', 'disputed', { source: 'OPERATOR' }).changeKind).toBe(
      'DISPUTE',
    );
    expect(step('SERVICE_JOB', 'REQUESTED', 'rejected').target).toBe('REJECTED');
    expect(step('SERVICE_JOB', 'ARRIVED', 'cancelled').target).toBe('CANCELLED');
    expect(step('SERVICE_JOB', 'EN_ROUTE', 'failed').target).toBe('FAILED');
    expect(step('SERVICE_JOB', 'UNKNOWN', 'arrived').target).toBe('ARRIVED');
    expect(step('SERVICE_JOB', 'WORK_REPORTED_COMPLETE', 'in_progress').disposition).toBe('ILLEGAL');
    expect(step('SERVICE_JOB', 'NO_SHOW', 'arrived').disposition).toBe('ILLEGAL');
    expect(step('SERVICE_JOB', 'SCOPE_CHANGE_PROPOSED', 'in_progress').disposition).toBe('ILLEGAL');
  });
});
