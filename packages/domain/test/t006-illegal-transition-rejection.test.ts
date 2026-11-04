// T-006 — Illegal state transition rejection: table-driven attempts at every prohibited incident, payment, order, job
// and recovery transition prove that state and ledger remain unchanged; every specified edge is accepted.
//
// EXPECTED is transcribed by hand from docs/spec/STATE-MACHINES.md (and CORE-CONTRACT.md), independently of the
// implementation tables, so a drift in either direction fails here.
import { DomainError, ID_PREFIXES, type EvidenceEnvelope } from '@uptimebuyer/contracts';
import { describe, expect, it } from 'vitest';
import {
  MACHINES,
  MACHINE_NAMES,
  allowedTargets,
  appendEvidence,
  applyTransition,
  isTransitionAllowed,
  resumeFromPause,
  transition,
  type MachineName,
} from '../src/index.js';

const EXPECTED: Record<MachineName, Record<string, readonly string[]>> = {
  INCIDENT: {
    DETECTED: ['TRIAGING', 'ESCALATED'],
    TRIAGING: ['AWAITING_EVIDENCE', 'PLANNING', 'ESCALATED', 'PAUSED'],
    AWAITING_EVIDENCE: ['PLANNING', 'ESCALATED', 'PAUSED'],
    PLANNING: ['AWAITING_APPROVAL', 'ESCALATED', 'PAUSED'],
    AWAITING_APPROVAL: ['EXECUTING', 'PLANNING', 'ESCALATED', 'PAUSED'],
    EXECUTING: ['VERIFYING', 'ESCALATED', 'PAUSED'],
    VERIFYING: ['RECOVERED', 'ESCALATED', 'PAUSED'],
    RECOVERED: ['REOPENED'],
    REOPENED: ['TRIAGING'],
    ESCALATED: ['TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING'],
    PAUSED: ['TRIAGING', 'AWAITING_EVIDENCE', 'PLANNING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING'],
  },
  EVIDENCE_REVISION: {
    DRAFT: ['VALIDATING', 'REJECTED'],
    VALIDATING: ['COMMITTED', 'REJECTED'],
    COMMITTED: [],
    REJECTED: [],
  },
  COMPATIBILITY_LIFECYCLE: { CURRENT: ['SUPERSEDED'], SUPERSEDED: [] },
  RECOVERY_PLAN: {
    DRAFT: ['EVALUATED', 'INVALIDATED'],
    EVALUATED: ['APPROVABLE', 'HELD', 'INVALIDATED'],
    APPROVABLE: ['APPROVED', 'REJECTED', 'INVALIDATED'],
    APPROVED: ['EXECUTING', 'INVALIDATED'],
    EXECUTING: ['COMPLETED', 'INVALIDATED'],
    COMPLETED: [],
    HELD: [],
    REJECTED: [],
    INVALIDATED: [],
  },
  EXECUTION_AUTHORITY: {
    ACTIVE: ['SUSPENDED', 'REVOKED', 'EXPIRED'],
    SUSPENDED: ['ACTIVE', 'REVOKED', 'EXPIRED'],
    REVOKED: [],
    EXPIRED: [],
  },
  KITE_SESSION: {
    PROPOSED: ['AUTHORIZED'],
    AUTHORIZED: ['REQUESTED', 'UNKNOWN'],
    REQUESTED: ['ACCEPTED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
    ACCEPTED: ['CONFIRMED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
    UNKNOWN: ['ACCEPTED', 'CONFIRMED', 'FAILED', 'CANCELLED'],
    CONFIRMED: [],
    FAILED: [],
    CANCELLED: [],
  },
  EXTERNAL_ACTION: {
    PROPOSED: ['AUTHORIZED'],
    AUTHORIZED: ['REQUESTED', 'UNKNOWN'],
    REQUESTED: ['ACCEPTED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
    ACCEPTED: ['CONFIRMED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
    UNKNOWN: ['ACCEPTED', 'CONFIRMED', 'FAILED', 'CANCELLED'],
    CONFIRMED: [],
    FAILED: [],
    CANCELLED: [],
  },
  ATTEMPT_TRANSPORT: {
    PREPARED: ['SEND_STARTED'],
    SEND_STARTED: ['ACKNOWLEDGED', 'UNKNOWN', 'DEFINITE_NO_EFFECT'],
    ACKNOWLEDGED: [],
    UNKNOWN: [],
    DEFINITE_NO_EFFECT: [],
  },
  ECONOMIC_INTENT: {
    CREATED: ['RESERVED', 'FAILED'],
    RESERVED: ['SUBMITTED', 'UNKNOWN', 'FAILED'],
    SUBMITTED: ['CONFIRMED', 'UNKNOWN', 'FAILED'],
    CONFIRMED: ['REFUNDED', 'REVERSED'],
    UNKNOWN: ['SUBMITTED', 'CONFIRMED', 'FAILED', 'REVERSED', 'REFUNDED'],
    FAILED: [],
    REFUNDED: [],
    REVERSED: [],
  },
  PURCHASE_ORDER: {
    REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    UNKNOWN: ['ACCEPTED', 'REJECTED', 'ORDERED', 'PARTIALLY_FILLED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED'],
    ACCEPTED: ['ORDERED', 'SUBSTITUTION_PROPOSED', 'CHANGE_REVIEW', 'CANCELLED', 'FAILED', 'UNKNOWN'],
    ORDERED: [
      'PARTIALLY_FILLED',
      'SHIPPED',
      'SUBSTITUTION_PROPOSED',
      'CHANGE_REVIEW',
      'CANCELLED',
      'FAILED',
      'UNKNOWN',
    ],
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
    VERIFIED: [],
    DISPUTED: [],
    REJECTED: [],
    CANCELLED: [],
    FAILED: [],
  },
  SERVICE_JOB: {
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
    NO_SHOW: [],
    VERIFIED: [],
    DISPUTED: [],
    REJECTED: [],
    CANCELLED: [],
    FAILED: [],
  },
  RECOVERY_EVALUATION: {
    PENDING: ['OBSERVING'],
    OBSERVING: ['PASSED', 'FAILED', 'EXPIRED'],
    PASSED: [],
    FAILED: [],
    EXPIRED: [],
  },
  DEVICE_HEALTH: {
    PROVISIONED: ['ONLINE', 'REVOKED'],
    ONLINE: ['STALE', 'REVOKED'],
    STALE: ['OFFLINE', 'ONLINE', 'REVOKED'],
    OFFLINE: ['ONLINE', 'REVOKED'],
    REVOKED: [],
  },
};

const ALL_WORDS = [...new Set(Object.values(EXPECTED).flatMap((t) => Object.keys(t)))].concat([
  'CLOSED',
  'COMPLETED_OK',
]);

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

const tenantId = `${ID_PREFIXES.tenant}_fixture01`;
const draft = (n: number, to: string) => ({
  evidenceId: `${ID_PREFIXES.evidence}_entry${String(n).padStart(4, '0')}`,
  tenantId,
  kind: 'POLICY_DECISION' as const,
  trust: 'AUTHORITATIVE' as const,
  subject: { aggregateType: 'incident' as const, aggregateId: `${ID_PREFIXES.incident}_fixture01` },
  incidentId: `${ID_PREFIXES.incident}_fixture01`,
  recordedAt: `2026-11-04T10:00:0${n}.000Z`,
  correlation: { correlationId: `${ID_PREFIXES.correlation}_fixture01`, causationId: null },
  payloadSchema: `state.transition_to_${to.toLowerCase()}.v1`,
  payloadDigest: `sha256:${'a'.repeat(64)}`,
  payloadRef: null,
  supersedesEvidenceId: null,
});

/** A minimal command handler: transition and append evidence, or change nothing. */
function handle(
  machine: MachineName,
  aggregate: { state: string; version: number },
  ledger: readonly EvidenceEnvelope[],
  to: string,
) {
  const next = applyTransition(machine, aggregate, to);
  return { aggregate: next, ledger: appendEvidence(ledger, draft(ledger.length + 1, to) as never) };
}

describe('T-006 illegal state transition rejection', () => {
  it('defines exactly the machines of STATE-MACHINES.md', () => {
    expect([...MACHINE_NAMES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const machine of Object.keys(EXPECTED) as MachineName[]) {
    describe(machine, () => {
      const table = EXPECTED[machine];
      const states = Object.keys(table);

      it('has exactly the specified state vocabulary', () => {
        expect([...MACHINES[machine].states].sort()).toEqual([...states].sort());
      });

      it('accepts every specified edge and exposes its guard as data', () => {
        for (const from of states)
          for (const to of table[from] ?? []) {
            const r = transition(machine, from, to);
            expect(r).toMatchObject({ machine, from, to });
            expect(r.guard.length).toBeGreaterThan(0);
          }
        const specEdges = states.flatMap((f) => (table[f] ?? []).map((t) => `${f}->${t}`)).sort();
        const implEdges = MACHINES[machine].edges.map((e) => `${e.from}->${e.to}`).sort();
        expect(implEdges).toEqual(specEdges);
      });

      it('rejects every unspecified pair with a typed error and leaves state and ledger unchanged', () => {
        const seedLedger = appendEvidence([], draft(1, 'seed') as never);
        let rejected = 0;
        for (const from of states)
          for (const to of states) {
            if ((table[from] ?? []).includes(to)) continue;
            expect(isTransitionAllowed(machine, from, to)).toBe(false);
            const aggregate = deepFreeze({ state: from, version: 3, tenantId });
            const before = structuredClone(aggregate);
            const ledger = deepFreeze([...seedLedger]);
            const ledgerBefore = structuredClone(ledger);
            let err: unknown;
            try {
              handle(machine, aggregate, ledger, to);
            } catch (e) {
              err = e;
            }
            expect(err, `${machine} ${from}->${to}`).toBeInstanceOf(DomainError);
            expect((err as DomainError).code).toBe('STATE_TRANSITION_INVALID');
            expect((err as DomainError).httpStatus).toBe(409);
            expect((err as DomainError).details).toMatchObject({ machine, from, to, reason: 'UNSPECIFIED_TRANSITION' });
            expect(aggregate).toEqual(before);
            expect(ledger).toEqual(ledgerBefore);
            rejected++;
          }
        const total = states.length * states.length;
        const allowed = states.reduce((n, f) => n + (table[f]?.length ?? 0), 0);
        expect(rejected).toBe(total - allowed);
      });

      it('rejects cross-kind and unknown state words as from and to', () => {
        const foreign = ALL_WORDS.filter((w) => !states.includes(w));
        for (const word of foreign) {
          for (const [from, to] of [
            [word, states[0] as string],
            [states[0] as string, word],
          ] as const) {
            expect(isTransitionAllowed(machine, from, to)).toBe(false);
            try {
              transition(machine, from, to);
              expect.unreachable(`${machine} ${from}->${to}`);
            } catch (e) {
              expect((e as DomainError).code).toBe('STATE_TRANSITION_INVALID');
              expect((e as DomainError).details.reason).toBe('STATE_NOT_IN_MACHINE');
            }
          }
        }
      });

      it('applies an allowed edge immutably, returning a new aggregate with version + 1', () => {
        const from = states.find((s) => (table[s] ?? []).length > 0) as string;
        const to = (table[from] as readonly string[])[0] as string;
        const aggregate = deepFreeze({ state: from, version: 3, tenantId });
        const result = handle(machine, aggregate, [], to);
        expect(result.aggregate).toEqual({ state: to, version: 4, tenantId });
        expect(result.aggregate).not.toBe(aggregate);
        expect(aggregate.state).toBe(from);
        expect(result.ledger).toHaveLength(1);
        expect(allowedTargets(machine, from)).toEqual([...(table[from] as readonly string[])]);
      });
    });
  }

  it('keeps purchase and service vocabularies separate even for shared raw words', () => {
    expect(isTransitionAllowed('PURCHASE_ORDER', 'ORDERED', 'SHIPPED')).toBe(true);
    expect(isTransitionAllowed('SERVICE_JOB', 'ORDERED', 'SHIPPED')).toBe(false);
    expect(isTransitionAllowed('SERVICE_JOB', 'EN_ROUTE', 'ARRIVED')).toBe(true);
    expect(isTransitionAllowed('PURCHASE_ORDER', 'EN_ROUTE', 'ARRIVED')).toBe(false);
    // Shared word UNKNOWN on separate axes does not make transport and outcome interchangeable.
    expect(isTransitionAllowed('ATTEMPT_TRANSPORT', 'SEND_STARTED', 'UNKNOWN')).toBe(true);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'SEND_STARTED', 'UNKNOWN')).toBe(false);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'AUTHORIZED', 'UNKNOWN')).toBe(false);
  });

  it('names the load-bearing edges explicitly', () => {
    expect(isTransitionAllowed('INCIDENT', 'AWAITING_APPROVAL', 'PLANNING')).toBe(true);
    expect(isTransitionAllowed('INCIDENT', 'EXECUTING', 'PLANNING')).toBe(false);
    expect(isTransitionAllowed('INCIDENT', 'EXECUTING', 'RECOVERED')).toBe(false);
    expect(isTransitionAllowed('INCIDENT', 'RECOVERED', 'TRIAGING')).toBe(false);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'AUTHORIZED', 'UNKNOWN')).toBe(true);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'ACCEPTED', 'UNKNOWN')).toBe(true);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'REQUESTED', 'FAILED')).toBe(true);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'REQUESTED', 'CANCELLED')).toBe(true);
    expect(isTransitionAllowed('EXTERNAL_ACTION', 'PROPOSED', 'REQUESTED')).toBe(false);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'SUBMITTED', 'FAILED')).toBe(true);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'UNKNOWN', 'REFUNDED')).toBe(true);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'CREATED', 'SUBMITTED')).toBe(false);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'FAILED', 'CREATED')).toBe(false);
    expect(isTransitionAllowed('ECONOMIC_INTENT', 'CONFIRMED', 'FAILED')).toBe(false);
    expect(isTransitionAllowed('RECOVERY_EVALUATION', 'PENDING', 'PASSED')).toBe(false);
  });

  it('resumes a paused incident only to its recorded prior state', () => {
    const paused = deepFreeze({ state: 'PAUSED', pausedFromState: 'EXECUTING', version: 5 });
    expect(resumeFromPause(paused, 'EXECUTING')).toEqual({ state: 'EXECUTING', pausedFromState: null, version: 6 });
    expect(() => resumeFromPause(paused, 'PLANNING')).toThrow(DomainError);
    expect(paused).toEqual({ state: 'PAUSED', pausedFromState: 'EXECUTING', version: 5 });
    expect(() => resumeFromPause({ state: 'PLANNING', pausedFromState: null, version: 1 }, 'PLANNING')).toThrow(
      DomainError,
    );
  });

  it('rejects an unknown machine name and keeps the tables immutable', () => {
    expect(() => transition('WALLET' as MachineName, 'A', 'B')).toThrow(DomainError);
    expect(() => (MACHINES.INCIDENT.edges as unknown as unknown[]).push({ from: 'RECOVERED', to: 'DETECTED' })).toThrow(
      TypeError,
    );
    expect(() => {
      (MACHINES.INCIDENT.states as unknown as string[])[0] = 'CLOSED';
    }).toThrow(TypeError);
    expect(isTransitionAllowed('INCIDENT', 'RECOVERED', 'DETECTED')).toBe(false);
  });

  it('rejects a non-integer or non-positive aggregate version', () => {
    expect(() => applyTransition('INCIDENT', { state: 'DETECTED', version: 1.5 }, 'TRIAGING')).toThrow(DomainError);
    expect(() => applyTransition('INCIDENT', { state: 'DETECTED', version: 0 }, 'TRIAGING')).toThrow(DomainError);
  });
});
